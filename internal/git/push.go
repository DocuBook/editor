package git

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
)

type Service struct {
	repoPath string
}

func New(repoPath string) *Service {
	return &Service{repoPath: repoPath}
}

type PushResult struct {
	Success bool   `json:"success"`
	Commit  string `json:"commit,omitempty"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

func (s *Service) Run(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = s.repoPath
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return stderr.String(), fmt.Errorf("git %s: %s", strings.Join(args, " "), stderr.String())
	}
	return strings.TrimSpace(stdout.String()), nil
}

func (s *Service) IsRepo() bool {
	_, err := s.Run("rev-parse", "--git-dir")
	return err == nil
}

func (s *Service) Status() (string, error) {
	out, err := s.Run("status", "--porcelain")
	if err != nil {
		return "", err
	}
	return out, nil
}

func (s *Service) AddAll() error {
	_, err := s.Run("add", "-A")
	return err
}

func (s *Service) Commit(message string) (string, error) {
	msg := message
	if msg == "" {
		msg = "Auto-commit from Editor"
	}
	_, err := s.Run("commit", "-m", msg)
	if err != nil {
		return "", err
	}
	hash, _ := s.Run("rev-parse", "HEAD")
	return hash, nil
}

func (s *Service) Push() error {
	_, err := s.Run("push")
	return err
}

func (s *Service) PushFull(message string) *PushResult {
	if !s.IsRepo() {
		return &PushResult{Error: "Not a git repository"}
	}

	status, err := s.Status()
	if err != nil {
		return &PushResult{Error: err.Error()}
	}
	if status == "" {
		return &PushResult{Success: true, Message: "Nothing to push"}
	}

	if err := s.AddAll(); err != nil {
		return &PushResult{Error: fmt.Sprintf("Add failed: %s", err.Error())}
	}

	hash, err := s.Commit(message)
	if err != nil {
		return &PushResult{Error: fmt.Sprintf("Commit failed: %s", err.Error())}
	}

	if err := s.Push(); err != nil {
		return &PushResult{
			Success: false,
			Commit:  hash,
			Error:   fmt.Sprintf("Push failed (commit saved locally): %s", err.Error()),
		}
	}

	return &PushResult{
		Success: true,
		Commit:  hash,
		Message: "Pushed successfully",
	}
}
