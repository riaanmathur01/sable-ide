# Third-party notices

Sable bundles the following data and libraries in addition to its npm and
Cargo dependencies (whose licenses ship in their packages).

## Spell-check dictionaries

The spell checker (`src/lib/spell`) loads these word lists at run time;
they are copied into the app's assets when it is built.

### English (US and UK) — SCOWL Hunspell dictionaries

From the npm packages [`dictionary-en`](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en)
and [`dictionary-en-gb`](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en-GB)
(license: MIT AND BSD), generated from
[SCOWL](http://wordlist.aspell.net/) (Spell Checker Oriented Word Lists).
The full license, including the Ispell (BSD) and the other notices SCOWL
carries, is the `license` file of each package
(`node_modules/dictionary-en/license`, `node_modules/dictionary-en-gb/license`).

> The collective work is Copyright 2000-2018 by Kevin Atkinson as well as
> any of the copyrights mentioned below:
>
> Copyright 2000-2018 by Kevin Atkinson
>
> Permission to use, copy, modify, distribute and sell these word lists,
> the associated scripts, the output created from the scripts, and its
> documentation for any purpose is hereby granted without fee, provided
> that the above copyright notice appears in all copies and that both that
> copyright notice and this permission notice appear in supporting
> documentation. Kevin Atkinson makes no representations about the
> suitability of this array for any purpose. It is provided "as is"
> without express or implied warranty.
>
> The affix file is a heavily modified version of the original
> english.aff file which was released as part of Geoff Kuenning's Ispell
> and as such is covered by his BSD license:
>
> Copyright 1993, Geoff Kuenning, Granada Hills, CA. All rights reserved.
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the conditions of the BSD
> license (reproduced in full in the package's `license` file) are met.

### Software terms — cspell-dicts

From the npm package
[`@cspell/dict-software-terms`](https://github.com/streetsidesoftware/cspell-dicts/tree/main/dictionaries/software-terms)
(`softwareTerms.txt.gz`, `software-tools.txt`, `coding-compound-terms.txt`,
`computing-acronyms.txt`, `webServices.txt`, `networkingTerms.txt`).

> The MIT License (MIT)
>
> Copyright (c) 2017-2025 Street Side Software <support@streetsidesoftware.nl>
>
> Permission is hereby granted, free of charge, to any person obtaining a
> copy of this software and associated documentation files (the
> "Software"), to deal in the Software without restriction, including
> without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the
> following conditions:
>
> The above copyright notice and this permission notice shall be included
> in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
> OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
> MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
> NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
> USE OR OTHER DEALINGS IN THE SOFTWARE.

## Emmet

Abbreviation expansion uses the [`emmet`](https://github.com/emmetio/emmet)
library (MIT, Copyright (c) 2020 Sergey Chikuyonok).
