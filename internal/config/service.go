package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type AIConfig struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	BaseURL  string `json:"baseUrl,omitempty"`
}

type DocuJson struct {
	Meta    MetaConfig     `json:"meta"`
	Routes  []RouteConfig  `json:"routes,omitempty"`
	Navbar  *NavConfig     `json:"navbar,omitempty"`
	Sidebar *SidebarConfig `json:"sidebar,omitempty"`
	Themes  *ThemeConfig   `json:"themes,omitempty"`
	AI      *AIConfig      `json:"ai,omitempty"`
}

type MetaConfig struct {
	Title   string `json:"title"`
	BaseURL string `json:"baseURL"`
}

type RouteConfig struct {
	Path  string `json:"path"`
	Title string `json:"title"`
	File  string `json:"file"`
}

type NavConfig struct {
	Items []NavItem `json:"items"`
}

type NavItem struct {
	Label string `json:"label"`
	Path  string `json:"path"`
}

type SidebarConfig struct {
	Items []SidebarItem `json:"items"`
}

type SidebarItem struct {
	Label    string         `json:"label"`
	Path     string         `json:"path"`
	Children []SidebarItem  `json:"children,omitempty"`
}

type ThemeConfig struct {
	Colors string `json:"colors"`
}

type Service struct {
	vaultPath string
}

func New(vaultPath string) *Service {
	return &Service{vaultPath: vaultPath}
}

func (s *Service) Path() string {
	return filepath.Join(s.vaultPath, "docu.json")
}

func (s *Service) Read() (*DocuJson, error) {
	data, err := os.ReadFile(s.Path())
	if err != nil {
		return nil, err
	}
	var cfg DocuJson
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (s *Service) Write(cfg *DocuJson) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.Path(), data, 0644)
}

func (s *Service) Exists() bool {
	_, err := os.Stat(s.Path())
	return err == nil
}

func (s *Service) Default() *DocuJson {
	return &DocuJson{
		Meta: MetaConfig{
			Title:   "My Project",
			BaseURL: "/",
		},
		Routes: []RouteConfig{},
		Themes: &ThemeConfig{Colors: "default"},
	}
}
