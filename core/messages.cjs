'use strict';
// Default messages retained from the original engine; no desktop translation dependency.
module.exports = { t: value => value, tr: (parts, ...values) => parts.reduce((text, part, i) => text + part + (values[i] ?? ''), '') };
