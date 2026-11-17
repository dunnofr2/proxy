/*global Ultraviolet*/
self['__uv' + '$config'] = {
  prefix: "/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv/" + "uv.handler" + ".js",
  client: "/uv/" + "uv.client" + ".js",
  bundle: "/lib/" + "core.bundle" + ".js",
  config: "/app.cfg" + ".js",
  sw: "/uv/" + "uv.sw" + ".js",
};
