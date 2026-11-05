// versionwatch checks every version DevHub pins against public lifecycle and advisory data.
// It reads data/versions.json and compose.yml, and sends only package names and versions out.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sync"
	"text/tabwriter"
	"time"
)

const (
	stateOK         = "ok"
	stateOutdated   = "outdated"
	stateEOLSoon    = "eol-soon"
	stateEOL        = "eol"
	stateVulnerable = "vulnerable"
	stateUntracked  = "untracked"
	stateUnknown    = "unknown"
	// Soon means there is still time to plan the move to the next release line.
	eolWarning = 180 * 24 * time.Hour
	workers    = 8
)

// Report is the output of one check.
type Report struct {
	CheckedAt string `json:"checkedAt"`
	Items     []Item `json:"items"`
}

// eolDate reads the `eol` field: a date, or a boolean when the project publishes no date.
func eolDate(raw json.RawMessage, now time.Time) (date string, ended bool) {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		parsed, err := time.Parse("2006-01-02", text)
		return text, err == nil && !parsed.After(now)
	}
	return "", string(raw) == "true"
}

func isLTS(raw json.RawMessage, now time.Time) bool {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		parsed, err := time.Parse("2006-01-02", text)
		return err == nil && !parsed.After(now)
	}
	return string(raw) == "true"
}

// classify gives an item its one state, worst first. A failed source never reads as healthy.
func classify(item *Item, ended bool, now time.Time) {
	soon := false
	if parsed, err := time.Parse("2006-01-02", item.EOL); err == nil {
		soon = parsed.Sub(now) < eolWarning
	}
	switch {
	case ended:
		item.State = stateEOL
	case len(item.Vulns) > 0:
		item.State = stateVulnerable
	case len(item.Errors) > 0:
		item.State = stateUnknown
	case soon:
		item.State = stateEOLSoon
	case behind(item.Version, item.Latest):
		item.State = stateOutdated
	case item.Kind == "image" && item.Cycle == "":
		item.State = stateUntracked
	default:
		item.State = stateOK
	}
}

func check(ctx context.Context, sources Sources, item *Item, now time.Time) {
	item.Vulns, item.Errors = []Vuln{}, []string{}
	failed := func(source string, err error) { item.Errors = append(item.Errors, fmt.Sprintf("%s: %v", source, err)) }
	ended, lineLatest := false, ""
	if product, ok := lifecycleProducts[item.Kind][item.Name]; ok && item.Version != "" {
		cycles, err := sources.cycles(ctx, product)
		if err != nil {
			failed("lifecycle", err)
		} else if cycle, ok := matchCycle(cycles, item.Version); ok {
			item.Cycle, item.LTS = cycle.name(), isLTS(cycle.LTS, now)
			item.EOL, ended = eolDate(cycle.EOL, now)
			lineLatest = cycle.Latest
			if item.Kind == "image" {
				item.Latest = cycles[0].Latest // The API lists the newest release line first.
			}
		} else {
			failed("lifecycle", fmt.Errorf("no release line for %s", item.Version))
		}
	}
	if item.Kind == "package" {
		latest, err := sources.latest(ctx, item.Ecosystem, item.Name)
		if err != nil {
			failed("registry", err)
		}
		item.Latest = latest
		// A package on a release line, such as an LTS, is compared within that line: the newer major is a choice.
		if lineLatest != "" {
			item.Latest = lineLatest
		}
		vulns, err := sources.vulns(ctx, item.Ecosystem, item.Name, item.Version)
		if err != nil {
			failed("advisories", err)
		}
		item.Vulns = append(item.Vulns, vulns...)
	}
	classify(item, ended, now)
}

func run(ctx context.Context, root string, sources Sources, now time.Time) (Report, error) {
	items, err := loadInventory(root)
	if err != nil {
		return Report{}, err
	}
	queue := make(chan *Item)
	var group sync.WaitGroup
	for range workers {
		group.Go(func() {
			for item := range queue {
				check(ctx, sources, item, now)
			}
		})
	}
	for index := range items {
		queue <- &items[index]
	}
	close(queue)
	group.Wait()
	return Report{CheckedAt: now.UTC().Format(time.RFC3339), Items: items}, nil
}

func printTable(report Report) {
	table := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(table, "STATE\tNAME\tVERSION\tLATEST\tEOL\tCVE")
	for _, item := range report.Items {
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\t%d\n", item.State, item.Name, item.Version, item.Latest, item.EOL, len(item.Vulns))
	}
	table.Flush()
}

func main() {
	root := flag.String("root", ".", "DevHub checkout")
	asJSON := flag.Bool("json", false, "print JSON")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	report, err := run(ctx, *root, publicSources(), time.Now())
	if err != nil {
		fmt.Fprintln(os.Stderr, "versionwatch:", err)
		os.Exit(2)
	}
	if *asJSON {
		if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
			fmt.Fprintln(os.Stderr, "versionwatch:", err)
			os.Exit(2)
		}
	} else {
		printTable(report)
	}
	for _, item := range report.Items {
		if item.State == stateEOL || item.State == stateVulnerable || item.State == stateUnknown {
			os.Exit(1)
		}
	}
}
