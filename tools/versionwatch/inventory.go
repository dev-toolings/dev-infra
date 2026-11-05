package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// Item is one version DevHub pins, with what the checks found about it.
type Item struct {
	Kind      string   `json:"kind"` // package or image
	Ecosystem string   `json:"ecosystem,omitempty"`
	Name      string   `json:"name"`
	Version   string   `json:"version"`
	Source    string   `json:"source"` // file that pins it
	State     string   `json:"state"`
	Latest    string   `json:"latest,omitempty"`
	Cycle     string   `json:"cycle,omitempty"`
	LTS       bool     `json:"lts"`
	EOL       string   `json:"eol,omitempty"`
	Vulns     []Vuln   `json:"vulns"`
	Errors    []string `json:"errors"`
}

// Vuln is one advisory that affects a pinned package.
type Vuln struct {
	ID       string `json:"id"`
	CVE      string `json:"cve,omitempty"`
	Summary  string `json:"summary"`
	Severity string `json:"severity,omitempty"`
	Fixed    string `json:"fixed,omitempty"`
}

// lifecycleProducts maps a pinned name to its endoflife.date product, per kind: `redis` is a server as an
// image and a client library as a package. Anything else has no public lifecycle.
var lifecycleProducts = map[string]map[string]string{
	"image": {
		"postgres": "postgresql", "mysql": "mysql", "redis": "redis", "rabbitmq": "rabbitmq", "node": "nodejs", "php": "php",
		"oven/bun": "bun", "ghcr.io/astral-sh/uv": "python", "dunglas/frankenphp": "php", "getmeili/meilisearch": "meilisearch",
	},
	"package": {
		"symfony/framework-bundle": "symfony", "symfony/runtime": "symfony", "symfony/string": "symfony", "symfony/console": "symfony",
		"symfony/dotenv": "symfony", "symfony/validator": "symfony", "symfony/serializer": "symfony", "symfony/property-access": "symfony",
		"symfony/property-info": "symfony", "symfony/mailer": "symfony", "symfony/twig-bundle": "symfony", "laravel/framework": "laravel",
	},
}

var (
	imageLine = regexp.MustCompile(`(?m)^\s*image:\s*["']?([^\s"']+)`)
	envImage  = regexp.MustCompile(`^\$\{[A-Z0-9_]+:-(.+)\}$`)
	// The version opens the tag: in `3.20-alpine3.19` the second number belongs to the base image.
	// In `1.13-php8.5-trixie` it follows the server version: what ages is PHP.
	tagVersion = regexp.MustCompile(`^(?:v|python|\d+(?:\.\d+)*-php)?(\d+(?:\.\d+)*)`)
)

// splitImage turns `name:tag@sha256:...` into its name and the version its tag carries.
func splitImage(reference string) (name, version string) {
	reference, _, _ = strings.Cut(reference, "@")
	slash := strings.LastIndex(reference, "/")
	colon := strings.LastIndex(reference, ":")
	if colon <= slash {
		return reference, ""
	}
	match := tagVersion.FindStringSubmatch(reference[colon+1:])
	if match == nil {
		return reference[:colon], ""
	}
	return reference[:colon], match[1]
}

func loadInventory(root string) ([]Item, error) {
	raw, err := os.ReadFile(filepath.Join(root, "data/versions.json"))
	if err != nil {
		return nil, err
	}
	var pins struct {
		NPM       map[string]string `json:"npm"`
		PyPI      map[string]string `json:"PyPI"`
		Packagist map[string]string `json:"Packagist"`
		Images    map[string]string `json:"images"`
		// A release line a project can choose: an image reference, or the Packagist pins of that line.
		Lines map[string]map[string]json.RawMessage `json:"lines"`
	}
	if err := json.Unmarshal(raw, &pins); err != nil {
		return nil, fmt.Errorf("data/versions.json: %w", err)
	}
	items := []Item{}
	addPackages := func(ecosystem string, packages map[string]string) {
		for name, version := range packages {
			items = append(items, Item{Kind: "package", Ecosystem: ecosystem, Name: name, Version: version, Source: "data/versions.json"})
		}
	}
	addImage := func(reference string) {
		image, tag := splitImage(reference)
		items = append(items, Item{Kind: "image", Name: image, Version: tag, Source: "data/versions.json"})
	}
	addPackages("npm", pins.NPM)
	addPackages("PyPI", pins.PyPI)
	addPackages("Packagist", pins.Packagist)
	for _, reference := range pins.Images {
		addImage(reference)
	}
	for _, lines := range pins.Lines {
		for _, line := range lines {
			var reference string
			if json.Unmarshal(line, &reference) == nil {
				addImage(reference)
				continue
			}
			packages := map[string]string{}
			if err := json.Unmarshal(line, &packages); err != nil {
				return nil, fmt.Errorf("data/versions.json: %w", err)
			}
			addPackages("Packagist", packages)
		}
	}
	compose, err := os.ReadFile(filepath.Join(root, "compose.yml"))
	if err != nil {
		return nil, err
	}
	for _, match := range imageLine.FindAllStringSubmatch(string(compose), -1) {
		reference := match[1]
		if fallback := envImage.FindStringSubmatch(reference); fallback != nil {
			reference = fallback[1]
		}
		image, tag := splitImage(reference)
		items = append(items, Item{Kind: "image", Name: image, Version: tag, Source: "compose.yml"})
	}
	sort.Slice(items, func(a, b int) bool { return items[a].Name+items[a].Version < items[b].Name+items[b].Version })
	// Several services can share an image: it is one pin to check.
	return slices.CompactFunc(items, func(a, b Item) bool {
		return a.Kind == b.Kind && a.Name == b.Name && a.Version == b.Version && a.Source == b.Source
	}), nil
}
