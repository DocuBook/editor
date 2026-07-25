package vault

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type FileType int

const (
	TypeFile FileType = iota
	TypeDir
)

type FileInfo struct {
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	Type     FileType  `json:"type"`
	Children []FileInfo `json:"children,omitempty"`
	Size     int64     `json:"size"`
}

type Service struct {
	vaultPath string
}

func New() *Service {
	return &Service{}
}

func (s *Service) safePath(path string) (string, error) {
	full := filepath.Join(s.vaultPath, path)
	clean := filepath.Clean(full)
	if !strings.HasPrefix(clean, filepath.Clean(s.vaultPath)) {
		return "", fs.ErrPermission
	}
	return clean, nil
}

func (s *Service) Open(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fs.ErrInvalid
	}
	s.vaultPath = path
	return nil
}

func (s *Service) Path() string {
	return s.vaultPath
}

func (s *Service) IsOpen() bool {
	return s.vaultPath != ""
}

func (s *Service) Tree(path string) ([]FileInfo, error) {
	root := s.vaultPath
	if path != "" {
		var err error
		root, err = s.safePath(path)
		if err != nil {
			return nil, err
		}
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}

	var files []FileInfo
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue // skip hidden
		}
		fi, _ := entry.Info()
		info := FileInfo{
			Path: filepath.Join(path, entry.Name()),
			Name: entry.Name(),
			Size: fi.Size(),
		}

		if entry.IsDir() {
			info.Type = TypeDir
		} else {
			info.Type = TypeFile
		}

		files = append(files, info)
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].Type != files[j].Type {
			return files[i].Type < files[j].Type // dirs first
		}
		return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
	})

	return files, nil
}

func (s *Service) Read(path string) (string, error) {
	full, err := s.safePath(path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (s *Service) Write(path, content string) error {
	full, err := s.safePath(path)
	if err != nil {
		return err
	}
	return os.WriteFile(full, []byte(content), 0644)
}

func (s *Service) Create(name, content string) (string, error) {
	full, err := s.safePath(name)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(full, []byte(content), 0644); err != nil {
		return "", err
	}
	return full, nil
}

func (s *Service) Rename(oldPath, newPath string) error {
	oldFull, err := s.safePath(oldPath)
	if err != nil {
		return err
	}
	newFull, err := s.safePath(newPath)
	if err != nil {
		return err
	}
	return os.Rename(oldFull, newFull)
}

func (s *Service) Delete(path string) error {
	full, err := s.safePath(path)
	if err != nil {
		return err
	}
	return os.RemoveAll(full)
}

func (s *Service) Mkdir(path string) error {
	full, err := s.safePath(path)
	if err != nil {
		return err
	}
	return os.MkdirAll(full, 0755)
}

func (s *Service) IsProject() bool {
	_, err := os.Stat(filepath.Join(s.vaultPath, "docu.json"))
	return err == nil
}
