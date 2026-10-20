package groups

import (
	"fmt"
	"strings"
)

func idx(format string, n int) string { return fmt.Sprintf(format, n) }
func lower(s string) string           { return strings.ToLower(s) }
func upper(s string) string           { return strings.ToUpper(s) }
