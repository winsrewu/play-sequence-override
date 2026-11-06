This project is licensed under GNU GPL v3.0 only. The following third-party components retain their own licenses.

# Third-party notices

## EfficientAT

This project vendors and uses **EfficientAT**:

- Upstream: <https://github.com/fschmid56/EfficientAT>
- Source used: the working tree at `/mnt/g/C/EfficientAT`, whose git remote is
  `https://github.com/fschmid56/EfficientAT.git`, commit
  `a425fdce92572e602a1d5634799bd9f1f2efa806` (2024-11-20), plus local
  working-tree changes present in that directory.
- Vendored at: `vendor/EfficientAT/`
- License: **MIT License**, Copyright (c) 2022 Florian Schmid.
- Full license text: `vendor/EfficientAT/LICENSE`.

The model checkpoint:

- `assets/mn10_as_mAP_471.pt`
- is the `mn10_as` / `mn10_as_mAP_471.pt` release artifact referenced by
  EfficientAT's `models/mn/model.py` from
  <https://github.com/fschmid56/EfficientAT/releases/tag/v0.0.1>.
- It is byte-identical to `/mnt/g/C/resources/mn10_as_mAP_471.pt` at the time
  of vendoring.
- EfficientAT's repository is distributed under the MIT license above; no
  separate model-weights license is stated in that repository.

### Local modifications

The vendored copy contains small compatibility changes made for this service:

- `helpers/utils.py`: resolve `metadata/class_labels_indices.csv` relative to
  the module instead of the process working directory.
- `models/preprocess.py`: use `torch.stft(return_complex=True)` +
  `torch.view_as_real(...)`, and the non-deprecated
  `torch.amp.autocast("cuda", enabled=False)` spelling.

These modifications are permitted by the MIT license. The original copyright
and permission notice remains in `vendor/EfficientAT/LICENSE`.

### Not distributed

AudioSet audio, metadata, and any other training data are **not** included in
this repository or the Docker image. Only EfficientAT source code, its
metadata CSV, and the released checkpoint are distributed.

## MIT license text

```text
MIT License

Copyright (c) 2022 Florian Schmid

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
```

## FireRedVAD

Vocal detection (singing or speech) uses **FireRedVAD** (audio event detection task):

- Upstream: <https://github.com/FireRedTeam/FireRedVAD>
- Model: <https://huggingface.co/FireRedTeam/FireRedVAD> (also on ModelScope)
- License: **Apache License 2.0**, Copyright 2026 Xiaohongshu.
- Full license text: `server/assets/fireredvad/LICENSE`.
- Vendored model: `server/assets/fireredvad/AED/` (`cmvn.ark`,
  `model.pth.tar`), the AED checkpoint from the release above.
