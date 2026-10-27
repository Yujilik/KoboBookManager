//go:build js && wasm

// Small application bridge to the MIT-licensed kepubify library.
package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"path"
	"strings"
	"syscall/js"

	"github.com/pgaskin/kepubify/v4/kepub"
)

func message(data map[string]interface{}) {
	js.Global().Call("postMessage", data)
}

// kepubify's optional dummy page fixes a Kobo layout issue, but v4.0.4 writes
// an empty XHTML title there. Keep the page and its spine position, giving only
// this generated document a valid title. Copy other ZIP entries as raw data.
func titleDummyPage(data []byte, source *zip.Reader) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	updates := make(map[string][]byte)
	for _, file := range reader.File {
		if path.Base(file.Name) != "kepubify-titlepage-dummy.xhtml" || file.UncompressedSize64 > 1024*1024 {
			continue
		}
		input, err := file.Open()
		if err != nil {
			return nil, err
		}
		contents, err := io.ReadAll(input)
		input.Close()
		if err != nil {
			return nil, err
		}
		if bytes.Contains(contents, []byte("<title></title>")) && bytes.Contains(contents, []byte("Page intentionally left blank by kepubify.")) {
			title := "<title>" + html.EscapeString(epubTitle(source)) + "</title>"
			updates[file.Name] = bytes.Replace(contents, []byte("<title></title>"), []byte(title), 1)
		}
	}
	if len(updates) == 0 {
		return data, nil
	}
	var result bytes.Buffer
	writer := zip.NewWriter(&result)
	for _, file := range reader.File {
		if contents, ok := updates[file.Name]; ok {
			header := file.FileHeader
			header.CRC32, header.CompressedSize, header.UncompressedSize = 0, 0, 0
			header.CompressedSize64, header.UncompressedSize64 = 0, 0
			output, err := writer.CreateHeader(&header)
			if err != nil {
				return nil, err
			}
			if _, err := output.Write(contents); err != nil {
				return nil, err
			}
		} else if err := writer.Copy(file); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return result.Bytes(), nil
}

func epubTitle(source *zip.Reader) string {
	var container struct {
		Rootfiles []struct {
			Path string `xml:"full-path,attr"`
		} `xml:"rootfiles>rootfile"`
	}
	if input, err := source.Open("META-INF/container.xml"); err == nil {
		err = xml.NewDecoder(io.LimitReader(input, 1024*1024)).Decode(&container)
		input.Close()
		if err == nil {
			for _, root := range container.Rootfiles {
				var document struct {
					Titles []string `xml:"metadata>title"`
				}
				if input, err := source.Open(root.Path); err == nil {
					err = xml.NewDecoder(io.LimitReader(input, 4*1024*1024)).Decode(&document)
					input.Close()
					if err == nil {
						for _, title := range document.Titles {
							if title = strings.TrimSpace(title); title != "" {
								return title
							}
						}
					}
				}
			}
		}
	}
	return "Title page"
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
	converted, err := titleDummyPage(output.Bytes(), reader)
	if err != nil {
		panic(fmt.Errorf("validar página de título: %w", err))
	}
	message(map[string]interface{}{"type": "progress", "n": 100, "total": 100})
	array := js.Global().Get("Uint8Array").New(len(converted))
	js.CopyBytesToJS(array, converted)
	buffer := array.Get("buffer")
	js.Global().Call("postMessage", map[string]interface{}{"type": "success", "kepub": buffer}, []interface{}{buffer})
}
