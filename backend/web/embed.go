package web

import "embed"

//go:embed index.html app.js styles.css landing.html status.html favicon.svg
var FS embed.FS
