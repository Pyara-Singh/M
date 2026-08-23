package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/google/uuid"
)

// Room represents a meeting session metadata.
// In this basic implementation, we only track the unique ID.
type Room struct {
	ID string `json:"id"`
}

// Global state variables.
var (
	// rooms maps a roomID string to a Room struct.
	rooms = make(map[string]Room)
	// mutex ensures that concurrent access to the 'rooms' map is thread-safe.
	mutex sync.RWMutex
)

// enableCORS is a middleware function that adds Cross-Origin Resource Sharing headers to responses.
// This allows the frontend (which might be on a different domain) to call this API.
func enableCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Allow requests from any origin.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		// Allow common HTTP methods.
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		// Allow common headers.
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding")

		// Handle preflight OPTIONS requests.
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		// Pass the request to the actual handler.
		next(w, r)
	}
}

// createRoom generates a new unique Room ID and stores it in memory.
// Returns the newly created room object as JSON.
func createRoom(w http.ResponseWriter, r *http.Request) {
	// Generate a fresh unique ID.
	roomID := uuid.New().String()
	room := Room{ID: roomID}

	// Safely add the room to our global map.
	mutex.Lock()
	rooms[roomID] = room
	mutex.Unlock()

	log.Printf("Room created: %s", roomID)
	
	// Send the room ID back to the client.
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(room)
}

// getRoom verifies if a room exists based on the roomId query parameter.
func getRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("roomId")

	// Read-lock the map for thread-safety during lookup.
	mutex.RLock()
	room, exists := rooms[roomID]
	mutex.RUnlock()

	// If the room doesn't exist, return a 404 error.
	if !exists {
		http.Error(w, `{"error": "Room not found"}`, http.StatusNotFound)
		return
	}

	// Return the room details as JSON.
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(room)
}

func main() {
	// Register API routes and wrap them with the CORS middleware.
	http.HandleFunc("/create-room", enableCORS(createRoom))
	http.HandleFunc("/get-room", enableCORS(getRoom))

	log.Println("Go API Gateway running on :8080")
	// Start the HTTP server on port 8080.
	// We bind to 0.0.0.0 to ensure it is accessible from outside the container/host.
	log.Fatal(http.ListenAndServe("0.0.0.0:8080", nil))
}