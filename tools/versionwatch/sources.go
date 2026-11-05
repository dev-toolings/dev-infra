package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Sources holds the public services, so that tests can point them at a local server.
type Sources struct {
	Client    *http.Client
	Lifecycle string
	OSV       string
	NPM       string
	PyPI      string
	Packagist string
}

func publicSources() Sources {
	return Sources{
		Client: &http.Client{Timeout: 20 * time.Second}, Lifecycle: "https://endoflife.date", OSV: "https://api.osv.dev",
		NPM: "https://registry.npmjs.org", PyPI: "https://pypi.org", Packagist: "https://repo.packagist.org",
	}
}

func (s Sources) request(ctx context.Context, method, target string, body any, out any) error {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, payload)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "devhub-versionwatch")
	request.Header.Set("Accept", "application/json")
	response, err := s.Client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d", request.URL.Host, response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(out)
}

// Cycle is one release line. `eol` and `lts` are a boolean or a date in the endoflife.date API.
type Cycle struct {
	Cycle  json.RawMessage `json:"cycle"`
	EOL    json.RawMessage `json:"eol"`
	LTS    json.RawMessage `json:"lts"`
	Latest string          `json:"latest"`
}

func (c Cycle) name() string { return strings.Trim(string(c.Cycle), `"`) }

// matchCycle finds the release line of a version. A floating tag such as `4` follows the newest line under it.
func matchCycle(cycles []Cycle, version string) (Cycle, bool) {
	best, found := Cycle{}, false
	for _, cycle := range cycles {
		name := cycle.name()
		if version == name || strings.HasPrefix(version, name+".") {
			if !found || len(name) > len(best.name()) {
				best, found = cycle, true
			}
		}
	}
	if found {
		return best, true
	}
	for _, cycle := range cycles {
		if strings.HasPrefix(cycle.name(), version+".") {
			return cycle, true
		}
	}
	return Cycle{}, false
}

func (s Sources) cycles(ctx context.Context, product string) ([]Cycle, error) {
	var cycles []Cycle
	err := s.request(ctx, http.MethodGet, s.Lifecycle+"/api/"+url.PathEscape(product)+".json", nil, &cycles)
	return cycles, err
}

var number = regexp.MustCompile(`\d+(?:\.\d+)*`)

// parts reads the numbers of a version, without its prefix or prerelease suffix.
func parts(version string) []int {
	numbers := []int{}
	for _, part := range strings.Split(number.FindString(version), ".") {
		if value, err := strconv.Atoi(part); err == nil {
			numbers = append(numbers, value)
		}
	}
	return numbers
}

func compareVersions(a, b []int) int {
	for index := range max(len(a), len(b)) {
		left, right := 0, 0
		if index < len(a) {
			left = a[index]
		}
		if index < len(b) {
			right = b[index]
		}
		if left != right {
			return cmp.Compare(left, right)
		}
	}
	return 0
}

// behind compares at the precision of the pin: a floating `16` is not behind 16.4, but it is behind 18.1.
func behind(version, latest string) bool {
	pin, newest := parts(version), parts(latest)
	if len(pin) == 0 || len(newest) == 0 {
		return false
	}
	return compareVersions(pin, newest[:min(len(pin), len(newest))]) < 0
}

var stableVersion = regexp.MustCompile(`^v?\d+\.\d+\.\d+$`)

// latest gives the newest stable release, within a release line when there is one. Only Packagist pins have a line.
func (s Sources) latest(ctx context.Context, ecosystem, name, line string) (string, error) {
	switch ecosystem {
	case "npm":
		var out struct{ Version string }
		err := s.request(ctx, http.MethodGet, s.NPM+"/"+name+"/latest", nil, &out)
		return out.Version, err
	case "PyPI":
		var out struct{ Info struct{ Version string } }
		err := s.request(ctx, http.MethodGet, s.PyPI+"/pypi/"+url.PathEscape(name)+"/json", nil, &out)
		return out.Info.Version, err
	case "Packagist":
		var out struct {
			Packages map[string][]struct{ Version string }
		}
		if err := s.request(ctx, http.MethodGet, s.Packagist+"/p2/"+name+".json", nil, &out); err != nil {
			return "", err
		}
		for _, release := range out.Packages[name] {
			version := strings.TrimPrefix(release.Version, "v")
			if stableVersion.MatchString(release.Version) && (line == "" || strings.HasPrefix(version, line+".")) {
				return version, nil
			}
		}
		return "", fmt.Errorf("no stable release of %s %s", name, line)
	}
	return "", fmt.Errorf("unknown ecosystem %s", ecosystem)
}

type osvEvent struct {
	Fixed string `json:"fixed"`
}
type osvAdvisory struct {
	ID       string   `json:"id"`
	Summary  string   `json:"summary"`
	Aliases  []string `json:"aliases"`
	Database struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
	Affected []struct {
		Package struct {
			Name string `json:"name"`
		} `json:"package"`
		Ranges []struct {
			Events []osvEvent `json:"events"`
		} `json:"ranges"`
	} `json:"affected"`
}

func (s Sources) vulns(ctx context.Context, ecosystem, name, version string) ([]Vuln, error) {
	query := map[string]any{"package": map[string]string{"name": name, "ecosystem": ecosystem}, "version": version}
	var found struct {
		Vulns []struct {
			ID string `json:"id"`
		} `json:"vulns"`
	}
	if err := s.request(ctx, http.MethodPost, s.OSV+"/v1/query", query, &found); err != nil {
		return nil, err
	}
	vulns := []Vuln{}
	var failure error
	for _, entry := range found.Vulns {
		var advisory osvAdvisory
		if err := s.request(ctx, http.MethodGet, s.OSV+"/v1/vulns/"+url.PathEscape(entry.ID), nil, &advisory); err != nil {
			// The query already proves it applies: only its details are missing.
			vulns, failure = append(vulns, Vuln{ID: entry.ID}), err
			continue
		}
		vuln := Vuln{ID: advisory.ID, Summary: advisory.Summary, Severity: strings.ToLower(advisory.Database.Severity)}
		for _, alias := range advisory.Aliases {
			if strings.HasPrefix(alias, "CVE-") {
				vuln.CVE = alias
			}
		}
		for _, affected := range advisory.Affected {
			if affected.Package.Name != name {
				continue
			}
			for _, versions := range affected.Ranges {
				for _, event := range versions.Events {
					// An advisory can list several branches: keep the nearest fix above this version.
					above := compareVersions(parts(event.Fixed), parts(version)) > 0
					if event.Fixed != "" && above && (vuln.Fixed == "" || compareVersions(parts(event.Fixed), parts(vuln.Fixed)) < 0) {
						vuln.Fixed = event.Fixed
					}
				}
			}
		}
		vulns = append(vulns, vuln)
	}
	return vulns, failure
}
