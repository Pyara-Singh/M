package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/google/uuid"
)

// Room represents a meeting session
type Room struct {
	ID string `json:"id"`
}

// Global state with a Mutex for thread-safety
var (
	rooms = make(map[string]Room)
	mutex sync.RWMutex
)

// Middleware to handle CORS
func enableCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

// createRoom generates a new unique Room ID
func createRoom(w http.ResponseWriter, r *http.Request) {
	roomID := uuid.New().String()
	room := Room{ID: roomID}

	mutex.Lock()
	rooms[roomID] = room
	mutex.Unlock()

	log.Printf("Room created: %s", roomID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(room)
}

// getRoom verifies if a room exists
func getRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("roomId")

	mutex.RLock()
	room, exists := rooms[roomID]
	mutex.RUnlock()

	if !exists {
		http.Error(w, `{"error": "Room not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(room)
}

func main() {
	// Routes with CORS middleware
	http.HandleFunc("/create-room", enableCORS(createRoom))
	http.HandleFunc("/get-room", enableCORS(getRoom))

	log.Println("Go API Gateway running on :8080")
	// Bind to all interfaces for production access
	log.Fatal(http.ListenAndServe("0.0.0.0:8080", nil))
}