package web

import "embed"

//go:embed index.html app.js styles.css landing.html
var FS embed.FS
