# Third-party notices

Photon itself is Copyright (c) 2026 Vladimir Demorcy, all rights reserved (see [LICENSE](LICENSE)).
It includes the third-party components below, which stay under their own licenses. The full
license texts are in the [licenses](licenses) folder, and each JavaScript package also keeps its
own license file inside `node_modules`.

## Bundled with every version

| Component | License | Where it's used | License text |
|---|---|---|---|
| Sora font | SIL Open Font License 1.1 | Headings in the app | [licenses/Sora-OFL.txt](licenses/Sora-OFL.txt) |
| IBM Plex Sans font | SIL Open Font License 1.1 | Text in the app | [licenses/IBMPlexSans-OFL.txt](licenses/IBMPlexSans-OFL.txt) |
| Lutron Caseta pairing certificates, from [pylutron-caseta](https://github.com/gurumitts/pylutron-caseta) | Apache License 2.0 | `src/lighting/lutron-certs.js`, used to pair with a Caseta bridge | [licenses/pylutron-caseta-Apache-2.0.txt](licenses/pylutron-caseta-Apache-2.0.txt) |
| LG webOS registration manifest, from [aiowebostv](https://github.com/home-assistant-libs/aiowebostv) | Apache License 2.0 | `src/media/tv/lg.js`, used to pair with an LG TV | [licenses/aiowebostv-Apache-2.0.txt](licenses/aiowebostv-Apache-2.0.txt) |

## Windows installer only

| Component | License | Where it's used | License text |
|---|---|---|---|
| [WinSW](https://github.com/winsw/winsw) 2.12.0 | MIT | Runs Photon as a Windows service | [licenses/WinSW-MIT.txt](licenses/WinSW-MIT.txt) |

On Windows and Mac, Node.js isn't included in the installer: setup downloads it from nodejs.org if
it's missing, under Node.js's own license.

## Android app only

| Component | License | Where it's used | License text |
|---|---|---|---|
| Node.js 18.20.4 built for Android by [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) | MIT (Node.js and the libraries it includes, such as V8, libuv, OpenSSL and ICU, are under their own licenses, listed in the Node.js license file) | Runs Photon on the phone | [licenses/nodejs-mobile-LICENSE.txt](licenses/nodejs-mobile-LICENSE.txt), [licenses/Node.js-18.20.4-LICENSE.txt](licenses/Node.js-18.20.4-LICENSE.txt) |
| LLVM libc++ from the Android NDK | Apache License 2.0 with LLVM Exceptions | C++ library Node.js needs | [licenses/LLVM-Apache-2.0-with-LLVM-exception.txt](licenses/LLVM-Apache-2.0-with-LLVM-exception.txt) |

## JavaScript packages

These are installed from npm and shipped in every version. Where a package offers a choice of
licenses, Photon uses it under the first one listed (node-forge under BSD-3-Clause).

| Package | Version | License | Source |
|---|---|---|---|
| accepts | 1.3.8 | MIT | jshttp/accepts |
| append-field | 1.0.0 | MIT | http://github.com/LinusU/node-append-field |
| array-flatten | 1.1.1 | MIT | https://github.com/blakeembrey/array-flatten |
| body-parser | 1.20.8 | MIT | expressjs/body-parser |
| busboy | 1.6.0 | MIT | http://github.com/mscdex/busboy |
| bytes | 3.1.2 | MIT | visionmedia/bytes.js |
| call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers |
| call-bound | 1.0.4 | MIT | https://github.com/ljharb/call-bound |
| content-disposition | 0.5.4 | MIT | jshttp/content-disposition |
| content-type | 1.0.5 | MIT | jshttp/content-type |
| cookie | 0.7.2 | MIT | jshttp/cookie |
| cookie-signature | 1.0.7 | MIT | https://github.com/visionmedia/node-cookie-signature |
| debug | 2.6.9 | MIT | https://github.com/visionmedia/debug |
| depd | 2.0.0 | MIT | dougwilson/nodejs-depd |
| destroy | 1.2.0 | MIT | stream-utils/destroy |
| dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto |
| ee-first | 1.1.1 | MIT | jonathanong/ee-first |
| encodeurl | 2.0.0 | MIT | pillarjs/encodeurl |
| es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property |
| es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors |
| es-object-atoms | 1.1.2 | MIT | https://github.com/ljharb/es-object-atoms |
| escape-html | 1.0.3 | MIT | component/escape-html |
| etag | 1.8.1 | MIT | jshttp/etag |
| express | 4.22.3 | MIT | expressjs/express |
| finalhandler | 1.3.2 | MIT | pillarjs/finalhandler |
| forwarded | 0.2.0 | MIT | jshttp/forwarded |
| fresh | 0.5.2 | MIT | jshttp/fresh |
| function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind |
| get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic |
| get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto |
| gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd |
| has-symbols | 1.1.0 | MIT | https://github.com/inspect-js/has-symbols |
| hasown | 2.0.4 | MIT | https://github.com/inspect-js/hasOwn |
| http-errors | 2.0.1 | MIT | jshttp/http-errors |
| iconv-lite | 0.4.24 | MIT | https://github.com/ashtuchkin/iconv-lite |
| inherits | 2.0.4 | ISC | https://github.com/isaacs/inherits |
| ipaddr.js | 1.9.1 | MIT | https://github.com/whitequark/ipaddr.js |
| math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics |
| media-typer | 0.3.0 | MIT | jshttp/media-typer |
| merge-descriptors | 1.0.3 | MIT | sindresorhus/merge-descriptors |
| methods | 1.1.2 | MIT | jshttp/methods |
| mime | 1.6.0 | MIT | https://github.com/broofa/node-mime |
| mime-db | 1.52.0 | MIT | jshttp/mime-db |
| mime-types | 2.1.35 | MIT | jshttp/mime-types |
| ms | 2.0.0 | MIT | zeit/ms |
| ms | 2.1.3 | MIT | vercel/ms |
| multer | 2.4.0 | MIT | https://github.com/expressjs/multer |
| negotiator | 0.6.3 | MIT | jshttp/negotiator |
| node-forge | 1.4.0 | (BSD-3-Clause OR GPL-2.0) | https://github.com/digitalbazaar/forge |
| object-inspect | 1.13.4 | MIT | https://github.com/inspect-js/object-inspect |
| on-finished | 2.4.1 | MIT | jshttp/on-finished |
| parseurl | 1.3.3 | MIT | pillarjs/parseurl |
| path-to-regexp | 0.1.13 | MIT | https://github.com/pillarjs/path-to-regexp |
| proxy-addr | 2.0.8 | MIT | jshttp/proxy-addr |
| qs | 6.16.0 | BSD-3-Clause | https://github.com/ljharb/qs |
| range-parser | 1.2.1 | MIT | jshttp/range-parser |
| raw-body | 2.5.3 | MIT | stream-utils/raw-body |
| safe-buffer | 5.2.1 | MIT | https://github.com/feross/safe-buffer |
| safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| send | 0.19.2 | MIT | pillarjs/send |
| serve-static | 1.16.3 | MIT | expressjs/serve-static |
| setprototypeof | 1.2.0 | ISC | https://github.com/wesleytodd/setprototypeof |
| side-channel | 1.1.1 | MIT | https://github.com/ljharb/side-channel |
| side-channel-list | 1.0.1 | MIT | https://github.com/ljharb/side-channel-list |
| side-channel-map | 1.0.1 | MIT | https://github.com/ljharb/side-channel-map |
| side-channel-weakmap | 1.0.2 | MIT | https://github.com/ljharb/side-channel-weakmap |
| statuses | 2.0.2 | MIT | jshttp/statuses |
| streamsearch | 1.1.0 | MIT | http://github.com/mscdex/streamsearch |
| suncalc | 1.9.0 | BSD-2-Clause | https://github.com/mourner/suncalc |
| three | 0.169.0 | MIT | https://github.com/mrdoob/three.js |
| toidentifier | 1.0.1 | MIT | component/toidentifier |
| type-is | 1.6.18 | MIT | jshttp/type-is |
| unpipe | 1.0.0 | MIT | stream-utils/unpipe |
| utils-merge | 1.0.1 | MIT | https://github.com/jaredhanson/utils-merge |
| vary | 1.1.2 | MIT | jshttp/vary |
| ws | 8.22.0 | MIT | https://github.com/websockets/ws |
