package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var now = time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)

func TestSplitImage(t *testing.T) {
	cases := map[string][2]string{
		"postgres:16-alpine":                            {"postgres", "16"},
		"rabbitmq:4-management-alpine":                  {"rabbitmq", "4"},
		"ghcr.io/astral-sh/uv:python3.14-bookworm-slim": {"ghcr.io/astral-sh/uv", "3.14"},
		"adminer:6.1.2@sha256:251295c1":                 {"adminer", "6.1.2"},
		"getmeili/meilisearch:v1.48":                    {"getmeili/meilisearch", "1.48"},
		"dunglas/frankenphp:1.13-php8.5-trixie":         {"dunglas/frankenphp", "8.5"},
		"node:lts":                                      {"node", ""},
		"nginx:alpine3.19":                              {"nginx", ""},
	}
	for reference, want := range cases {
		if name, version := splitImage(reference); name != want[0] || version != want[1] {
			t.Errorf("%s: got %s %s", reference, name, version)
		}
	}
}

func TestMatchCycle(t *testing.T) {
	cycles := []Cycle{{Cycle: json.RawMessage(`"4.1"`)}, {Cycle: json.RawMessage(`"4.0"`)}, {Cycle: json.RawMessage(`16`)}}
	for version, want := range map[string]string{"4.0.3": "4.0", "4": "4.1", "16": "16"} {
		if cycle, ok := matchCycle(cycles, version); !ok || cycle.name() != want {
			t.Errorf("%s: got %s", version, cycle.name())
		}
	}
	if _, ok := matchCycle(cycles, "3"); ok {
		t.Error("3 matched a release line")
	}
}

func TestClassifyOrdersTheWorstStateFirst(t *testing.T) {
	cases := []struct {
		name  string
		item  Item
		ended bool
		want  string
	}{
		{"ended beats advisories", Item{Vulns: []Vuln{{ID: "x"}}}, true, stateEOL},
		{"advisory", Item{Vulns: []Vuln{{ID: "x"}}}, false, stateVulnerable},
		{"failed source is not healthy", Item{Errors: []string{"down"}}, false, stateUnknown},
		{"ends soon", Item{EOL: "2027-01-01"}, false, stateEOLSoon},
		{"newer release", Item{Version: "1.0.0", Latest: "1.0.1"}, false, stateOutdated},
		{"floating tag is not outdated", Item{Kind: "image", Cycle: "16", Version: "16", Latest: "16.4"}, false, stateOK},
		{"floating tag behind a newer line", Item{Kind: "image", Cycle: "16", Version: "16", Latest: "18.1"}, false, stateOutdated},
		{"a pin ahead of the registry", Item{Version: "2.0.0", Latest: "1.9.9"}, false, stateOK},
		{"a higher minor is not text order", Item{Version: "1.9.0", Latest: "1.10.0"}, false, stateOutdated},
		{"no lifecycle", Item{Kind: "image"}, false, stateUntracked},
		{"healthy", Item{Version: "1.0.0", Latest: "1.0.0", EOL: "2030-01-01"}, false, stateOK},
	}
	for _, test := range cases {
		classify(&test.item, test.ended, now)
		if test.item.State != test.want {
			t.Errorf("%s: got %s", test.name, test.item.State)
		}
	}
}

func TestRunReportsAdvisoriesAndKeepsGoingWhenASourceFails(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/php.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`[{"cycle":"8.1","eol":"2025-12-31","lts":false,"latest":"8.1.33"}]`))
	})
	mux.HandleFunc("/pypi/fastapi/json", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"info":{"version":"1.0.0"}}`)) })
	mux.HandleFunc("/v1/query", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"vulns":[{"id":"GHSA-1"}]}`)) })
	mux.HandleFunc("/v1/vulns/GHSA-1", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"id":"GHSA-1","summary":"bad","aliases":["CVE-2026-1"],"database_specific":{"severity":"HIGH"},"affected":[{"package":{"name":"fastapi"},"ranges":[{"events":[{"introduced":"0"},{"fixed":"1.0.0"}]}]}]}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "data"), 0o755)
	os.WriteFile(filepath.Join(root, "data/versions.json"), []byte(`{"PyPI":{"fastapi":"0.9.0","redis":"1.0.0"},"lines":{"php":{"8.1":"php:8.1-cli"}}}`), 0o644)
	os.WriteFile(filepath.Join(root, "compose.yml"), []byte("services:\n  a:\n    image: ${A:-redis:7-alpine}\n"), 0o644)

	sources := Sources{Client: server.Client(), Lifecycle: server.URL, OSV: server.URL, PyPI: server.URL}
	report, err := run(context.Background(), root, sources, now)
	if err != nil {
		t.Fatal(err)
	}
	states := map[string]Item{}
	for _, item := range report.Items {
		states[item.Kind+":"+item.Name] = item
	}
	if got := states["package:fastapi"]; got.State != stateVulnerable || got.Vulns[0].CVE != "CVE-2026-1" || got.Vulns[0].Fixed != "1.0.0" || got.Vulns[0].Severity != "high" {
		t.Errorf("fastapi: %+v", got)
	}
	if got := states["image:php"]; got.State != stateEOL || got.Cycle != "8.1" {
		t.Errorf("php: %+v", got)
	}
	if got := states["package:redis"]; got.Cycle != "" {
		t.Errorf("the redis client took the lifecycle of the server: %+v", got)
	}
	if got := states["image:redis"]; got.State != stateUnknown || len(got.Errors) != 1 {
		t.Errorf("redis: %+v", got)
	}
}

func TestAnAdvisoryWithoutDetailsStillCounts(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/query", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"vulns":[{"id":"GHSA-2"}]}`)) })
	server := httptest.NewServer(mux)
	defer server.Close()
	vulns, err := Sources{Client: server.Client(), OSV: server.URL}.vulns(context.Background(), "npm", "demo", "1.0.0")
	if err == nil || len(vulns) != 1 || vulns[0].ID != "GHSA-2" {
		t.Fatalf("got %+v, %v", vulns, err)
	}
	item := Item{Vulns: vulns, Errors: []string{err.Error()}}
	classify(&item, false, now)
	if item.State != stateVulnerable {
		t.Errorf("got %s", item.State)
	}
}

func TestSharedImageIsOnePin(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "data"), 0o755)
	os.WriteFile(filepath.Join(root, "data/versions.json"), []byte(`{}`), 0o644)
	os.WriteFile(filepath.Join(root, "compose.yml"), []byte("services:\n  a:\n    image: redis:7\n  b:\n    image: redis:7\n"), 0o644)
	items, err := loadInventory(root)
	if err != nil || len(items) != 1 {
		t.Fatalf("got %+v, %v", items, err)
	}
}

func TestAPackageOnAnLTSLineIsComparedWithinIt(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/symfony.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`[{"cycle":"8.1","eol":"2027-01-31","lts":false,"latest":"8.1.10"},{"cycle":"7.4","eol":"2029-11-30","lts":true,"latest":"7.4.22"}]`))
	})
	mux.HandleFunc("/p2/symfony/string.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"packages":{"symfony/string":[{"version":"v8.1.10"},{"version":"v7.4.20"},{"version":"v7.4.19"}]}}`))
	})
	mux.HandleFunc("/v1/query", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{}`)) })
	server := httptest.NewServer(mux)
	defer server.Close()
	sources := Sources{Client: server.Client(), Lifecycle: server.URL, OSV: server.URL, Packagist: server.URL}
	// The framework is at 7.4.22, but this component has no release since 7.4.20.
	item := Item{Kind: "package", Ecosystem: "Packagist", Name: "symfony/string", Version: "7.4.20"}
	check(context.Background(), sources, &item, now)
	if item.State != stateOK || !item.LTS || item.Latest != "7.4.20" {
		t.Errorf("got %+v", item)
	}
	behind := Item{Kind: "package", Ecosystem: "Packagist", Name: "symfony/string", Version: "7.4.19"}
	check(context.Background(), sources, &behind, now)
	if behind.State != stateOutdated || behind.Latest != "7.4.20" {
		t.Errorf("got %+v", behind)
	}
}
