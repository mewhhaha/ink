# Basis Universal transcoder

`basis_transcoder.js` and `basis_transcoder.wasm` are the WebAssembly KTX2 /
Basis Universal transcoder from <https://github.com/BinomialLLC/basis_universal>,
licensed under the Apache License 2.0
(<https://github.com/BinomialLLC/basis_universal/blob/master/LICENSE>), copied
from three.js r186 (`examples/jsm/libs/basis`). The JavaScript file has two
edits: Node detection is disabled (and its `require` calls removed) and the UMD tail is an ES module export.
