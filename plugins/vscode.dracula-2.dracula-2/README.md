> Converted from the VS Code extension **Dracula-2.dracula-2** 0.3.8 by Sable. Choose a theme in Settings → Editor Appearance → Color Theme, or with "Color Theme: …" in the command palette (⇧⌘P).

Themes:

- Darcula

# Dracula Theme Remastered for VS Code

![Version](https://img.shields.io/badge/version-0.3.8-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![VS Code](https://img.shields.io/badge/VS%20Code-^1.64.0-blue)

A refined dark theme for Visual Studio Code with purple and pink colors, enhanced semantic highlighting, and modern VS Code integration.

## Features

- Enhanced semantic token support for modern language features
- Comprehensive bracket pair colorization with 6 distinct colors
- Improved git decorations for staged, renamed, and conflict files
- Unicode highlighting for potentially confusing characters
- Optimized color contrast for better readability
- Full workbench theming including sidebar, tabs, and terminal

## Installation

### From Open VSX (Recommended)

```bash
code --install-extension Dracula-2.dracula-2
```

### Manual Installation

1. Download the latest `.vsix` file from releases
2. Run: `code --install-extension dracula-2-0.3.8.vsix`

## Color Palette

- **Purple** (#bd93f9) - Keywords, storage types
- **Green** (#50fa7b) - Strings, success indicators
- **Cyan** (#8be9fd) - Functions, methods, types
- **Pink** (#ff79c6) - Operators, tags, cursor
- **Yellow** (#f1fa8c) - Classes, warnings
- **Orange** (#ffb86c) - Parameters, constants
- **Red** (#ff5555) - Errors, deletions
- **Background** (#282a36) - Editor background
- **Foreground** (#f8f8f2) - Default text
- **Comment** (#6272a4) - Comments, inactive code

## Supported Languages

Optimized for:
- JavaScript/TypeScript
- Python
- Java
- C/C++
- Go
- Rust
- HTML/CSS
- JSON/YAML
- Markdown
- And many more...

## Configuration

### Telemetry Settings

Control anonymous usage telemetry:

```json
{
    "darcula.telemetry.enabled": true,
    "darcula.telemetry.endpoint": "https://usage.vsext.space/telemetry"
}
```

### Debug Mode

Enable debug logging:

```json
{
    "darcula.debug.enabled": false
}
```

## Development

### Build from Source

```bash
# Install dependencies
pnpm install

# Compile TypeScript
pnpm run compile

# Package extension
pnpm run package
```

### Testing

```bash
# Run all tests
pnpm run test

# Unit tests only
pnpm run test:unit

# Integration tests
pnpm run test:integration

# Pre-publish validation
pnpm run test:pre-publish
```

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

MIT License - see LICENSE file for details.

## Credits

Based on the original Dracula Theme by Zeno Rocha.
Enhanced version by TimDeen.

---

**Publisher**: Dracula-2  
**Version**: 0.3.8  
**Repository**: [GitHub](https://github.com/TimDeen/Dracula-2)