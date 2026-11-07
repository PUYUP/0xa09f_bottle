package api

import (
	"encoding/json"
	"io/fs"
	"mime"
	"path"
	"strings"

	"a09f/bottle/web"

	"github.com/gofiber/fiber/v3"
)

func init() {
	_ = mime.AddExtensionType(".js", "text/javascript; charset=utf-8")
	_ = mime.AddExtensionType(".css", "text/css; charset=utf-8")
	_ = mime.AddExtensionType(".html", "text/html; charset=utf-8")
}

func bindJSON(c fiber.Ctx, v any) error {
	if len(c.Body()) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "empty body")
	}
	return json.Unmarshal(c.Body(), v)
}

func (s *Server) serveStatic(c fiber.Ctx) error {
	if c.Method() != fiber.MethodGet && c.Method() != fiber.MethodHead {
		return c.Next()
	}
	raw := c.Path()
	if strings.HasPrefix(raw, "/api/") {
		return c.Next()
	}
	name := strings.TrimPrefix(raw, "/")
	if name == "" {
		name = "index.html"
	}
	name = path.Clean(name)
	if strings.HasPrefix(name, "../") || name == ".." {
		return c.Status(fiber.StatusNotFound).SendString("not found")
	}
	data, err := fs.ReadFile(web.FS, name)
	if err != nil {
		return c.Status(fiber.StatusNotFound).SendString("not found")
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Set("Content-Type", contentType)
	c.Set("Cache-Control", "no-store")
	return c.Send(data)
}
