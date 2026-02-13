package main

import (
	"crypto/rand"
	_ "embed"
	"encoding/binary"
	"strings"
)

//go:embed bip39_english.txt
var bip39Raw string

var bip39Words []string

func init() {
	bip39Words = strings.Split(strings.TrimSpace(bip39Raw), "\n")
	if len(bip39Words) != 2048 {
		panic("bip39 wordlist must have exactly 2048 words")
	}
}

// generateInviteHandle returns two random BIP39 words joined by a hyphen.
func generateInviteHandle() string {
	return bip39Words[randWord()] + "-" + bip39Words[randWord()]
}

func randWord() int {
	var buf [2]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return int(binary.BigEndian.Uint16(buf[:])) % 2048
}
