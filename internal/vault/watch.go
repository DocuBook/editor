package vault

import (
	"log"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/fsnotify/fsnotify"
)

type Watcher struct {
	watcher *fsnotify.Watcher
	version atomic.Int64
	closed  chan struct{}
}

func NewWatcher() *Watcher {
	return &Watcher{closed: make(chan struct{})}
}

func (w *Watcher) Start(vaultPath string) error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w.watcher = fw

	// Watch root and all subdirectories recursively
	if err := filepath.Walk(vaultPath, func(path string, info os.FileInfo, err error) error {
		if err != nil || !info.IsDir() {
			return nil
		}
		return fw.Add(path)
	}); err != nil {
		return err
	}

	go func() {
		for {
			select {
			case event := <-fw.Events:
				if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) != 0 {
					w.version.Add(1)
					// If a new directory is created, watch it
					if event.Op&fsnotify.Create != 0 {
						if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
							fw.Add(event.Name)
						}
					}
				}
			case err := <-fw.Errors:
				if err != nil {
					log.Printf("fsnotify error: %v", err)
				}
			case <-w.closed:
				return
			}
		}
	}()

	return nil
}

func (w *Watcher) Version() int64 {
	return w.version.Load()
}

func (w *Watcher) Close() {
	close(w.closed)
	if w.watcher != nil {
		w.watcher.Close()
	}
}
