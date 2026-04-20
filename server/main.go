package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type Room struct {
	ID string `json:"id"`
}

var rooms = make(map[string]Room)

// ======================
// CREATE ROOM
// ======================
func createRoom(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	if r.Method == "OPTIONS" {
		return
	}

	roomID := uuid.New().String()

	room := Room{ID: roomID}
	rooms[roomID] = room

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(room)
}

// ======================
// GET ROOM
// ======================
func getRoom(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	if r.Method == "OPTIONS" {
		return
	}

	roomID := r.URL.Query().Get("roomId")

	room, exists := rooms[roomID]
	if !exists {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(room)
}

// ======================
// MAIN
// ======================
func main() {
	http.HandleFunc("/create-room", createRoom)
	http.HandleFunc("/get-room", getRoom)

	log.Println("Go server running on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}