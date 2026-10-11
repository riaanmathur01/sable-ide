// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** @type {{ id: string, name: string, url: string }[]} */
const LICENSES = [
  { id: "MIT", name: "MIT License", url: "https://opensource.org/license/mit" },
  { id: "Apache-2.0", name: "Apache License 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  { id: "BSD-3-Clause", name: "BSD 3-Clause License", url: "https://opensource.org/license/bsd-3-clause" },
  { id: "GPL-3.0-or-later", name: "GNU General Public License v3.0 or later", url: "https://www.gnu.org/licenses/gpl-3.0.txt" },
  { id: "MPL-2.0", name: "Mozilla Public License 2.0", url: "https://mozilla.org/MPL/2.0/" },
];

/** How each language writes a comment: a line prefix, or an opening and closing pair. */
const LINE = (prefix) => ({ prefix });
const BLOCK = (open, line, close) => ({ open, line, close });
/** @type {Record<string, { prefix?: string, open?: string, line?: string, close?: string }>} */
const COMMENTS = {};
const style = (languages, comment) => languages.split(" ").forEach((language) => (COMMENTS[language] = comment));
style(
  "javascript typescript javascriptreact typescriptreact java c cpp csharp go rust swift kotlin scala dart php scss less objective-c objective-cpp fsharp groovy solidity proto",
  LINE("//"),
);
style("python shell ruby perl r yaml toml dockerfile makefile powershell coffeescript julia elixir graphql tcl cmake", LINE("#"));
style("sql mysql pgsql lua haskell elm", LINE("--"));
style("clojure scheme lisp", LINE(";;"));
style("ini", LINE(";"));
style("bat", LINE("REM"));
style("vb", LINE("'"));
style("css", BLOCK("/*", " * ", " */"));
style("html xml markdown vue svelte", BLOCK("<!--", "  ", "-->"));

/** The header's lines as a comment in `comment`'s style. */
function commentLines(lines, comment) {
  if (comment.prefix) return lines.map((line) => `${comment.prefix} ${line}`);
  return [comment.open, ...lines.map((line) => comment.line + line), comment.close];
}

/** "Copyright (c) 2026 Jane Doe" + the SPDX identifier. */
const headerLines = (license, year, author) => [`Copyright (c) ${year} ${author}`, `SPDX-License-Identifier: ${license}`];

/** How many lines at the top must stay first: a #! line, an encoding
 *  comment, <?xml …?>, <?php or <!DOCTYPE …>. */
function preambleLength(lines) {
  let count = 0;
  while (
    count < lines.length &&
    ((count === 0 && /^#!/.test(lines[count])) ||
      /^#.*coding[:=]/.test(lines[count]) ||
      /^\s*<\?(xml|php)\b/i.test(lines[count]) ||
      /^\s*<!doctype\b/i.test(lines[count]))
  ) count++;
  return count;
}

/** The edit putting the header at the top of `text` (after any preamble). */
function headerEdit(text, header) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const at = preambleLength(lines);
  const block = header.join(eol);
  if (at >= lines.length) {
    // Only a preamble, with no line after it: start a new line.
    const last = lines.length;
    const position = { line: last, column: lines[last - 1].length + 1 };
    return { range: { start: position, end: position }, text: eol + block + eol };
  }
  const position = { line: at + 1, column: 1 };
  // A blank line after the header (unless the file is empty).
  const after = text.trim() ? eol + eol : eol;
  return { range: { start: position, end: position }, text: block + after };
}

const MIT = (year, author) => `MIT License

Copyright (c) ${year} ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const BSD3 = (year, author) => `BSD 3-Clause License

Copyright (c) ${year}, ${author}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

/** The standard notice each license asks you to put in your project. */
const NOTICES = {
  "Apache-2.0": `Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`,
  "GPL-3.0-or-later": `This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.`,
  "MPL-2.0": `This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.`,
};

/** The LICENSE file's text: MIT and BSD in full; the others as their
 *  official notice, pointing to the full text. */
function licenseFile(license, year, author) {
  if (license.id === "MIT") return MIT(year, author);
  if (license.id === "BSD-3-Clause") return BSD3(year, author);
  return `${license.name} (${license.id})

Copyright (c) ${year} ${author}

${NOTICES[license.id]}

The full license text: ${license.url}
`;
}

/** @param {Sable} sable */
export function activate(sable) {
  /** Asks which license (the last one used first), or null. */
  const pickLicense = async (placeholder) => {
    const last = await sable.storage.get("license");
    const ordered = [...LICENSES].sort((a, b) => Number(b.id === last) - Number(a.id === last));
    const choice = await sable.window.showQuickPick(
      ordered.map((license) => ({ label: license.id, description: license.name, license })),
      { placeholder },
    );
    if (choice) await sable.storage.set("license", choice.license.id);
    return choice?.license ?? null;
  };

  /** The copyright holder: asked the first time, then remembered. */
  const author = async (ask = false) => {
    const saved = await sable.storage.get("author");
    if (typeof saved === "string" && saved && !ask) return saved;
    const name = await sable.window.showInputBox({
      prompt: "Copyright holder for license headers (your name or organisation)",
      placeholder: "Jane Doe",
      value: typeof saved === "string" ? saved : "",
    });
    if (!name?.trim()) return null;
    await sable.storage.set("author", name.trim());
    return name.trim();
  };

  sable.commands.register("insert", "Insert License Header…", async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.window.showError("Open a file first");
    const comment = COMMENTS[editor.language];
    if (!comment) return sable.window.showError(`License Header doesn't know how to write a comment in ${editor.language}`);
    if (/SPDX-License-Identifier/.test(editor.text.split("\n").slice(0, 30).join("\n"))) {
      return sable.window.showWarning("This file already has a license header");
    }
    const license = await pickLicense("License for this file's header");
    if (!license) return;
    const holder = await author();
    if (!holder) return;
    const header = commentLines(headerLines(license.id, new Date().getFullYear(), holder), comment);
    await sable.editor.applyEdits([headerEdit(editor.text, header)]);
  });

  sable.commands.register("createFile", "Create LICENSE File…", async () => {
    if (!sable.workspace.root) return sable.window.showError("Open a folder first");
    const license = await pickLicense("License for the project's LICENSE file");
    if (!license) return;
    // Warn before overwriting (or adding to) an existing license file.
    for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
      const exists = await sable.workspace.readFile(name).then(() => true, () => false);
      if (!exists) continue;
      const replace = name === "LICENSE" ? "Replace LICENSE" : "Create LICENSE anyway";
      const answer = await sable.window.showQuickPick([replace, "Cancel"], { placeholder: `${name} already exists` });
      if (answer !== replace) return;
      break;
    }
    const holder = await author();
    if (!holder) return;
    await sable.workspace.writeFile("LICENSE", licenseFile(license, new Date().getFullYear(), holder));
    await sable.editor.open("LICENSE");
    await sable.window.showMessage(`Wrote LICENSE (${license.id})`);
  });

  sable.commands.register("author", "Change Copyright Holder…", async () => {
    const name = await author(true);
    if (name) await sable.window.showMessage(`License headers will name ${name}`);
  });
}
