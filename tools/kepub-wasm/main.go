//go:build js && wasm

// Small application bridge to the MIT-licensed kepubify library.
package main

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"syscall/js"

	"github.com/pgaskin/kepubify/v4/kepub"
)

func message(data map[string]interface{}) {
	js.Global().Call("postMessage", data)
}

func main() {
	defer func() {
		if err := recover(); err != nil {
			message(map[string]interface{}{"type": "error", "message": fmt.Sprint(err)})
		}
	}()
	input := js.Global().Get("Uint8Array").New(js.Global().Get("init").Get("epub"))
	data := make([]byte, input.Get("byteLength").Int())
	js.CopyBytesToGo(data, input)
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		panic(fmt.Errorf("ler EPUB: %w", err))
	}
	message(map[string]interface{}{"type": "progress", "n": 5, "total": 100})
	var output bytes.Buffer
	if err := kepub.NewConverter().Convert(context.Background(), &output, reader); err != nil {
		panic(fmt.Errorf("converter EPUB: %w", err))
	}
	array := js.Global().Get("Uint8Array").New(output.Len())
	js.CopyBytesToJS(array, output.Bytes())
	buffer := array.Get("buffer")
	js.Global().Call("postMessage", map[string]interface{}{"type": "success", "kepub": buffer}, []interface{}{buffer})
}
