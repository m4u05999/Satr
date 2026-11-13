// إمالة ومنظور ثلاثي الأبعاد للجهاز عبر WebGL2 خام (بلا مكتبات).
// نسيج من لوحة 2D يُرسم على مستطيل بمصفوفة منظور، ثم تُنسخ النتيجة إلى اللوحة الرئيسية.
// إن تعذّر إنشاء سياق WebGL2 تعيد الدوال null، والمستدعي يرسم بلا إمالة (بديل 2D).

const VERTEX = `#version 300 es
in vec2 position;
uniform mat4 matrix;
out vec2 uv;
void main() {
  uv = position * 0.5 + 0.5;
  gl_Position = matrix * vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D image;
out vec4 color;
void main() {
  color = texture(image, vec2(uv.x, 1.0 - uv.y));
}`;

let state = null;      // { canvas, gl, program, texture, matrixLocation }
let unavailable = false;

function setup() {
  if (state || unavailable) return state;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('no_webgl2');
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    state = { canvas, gl, program, texture, matrixLocation: gl.getUniformLocation(program, 'matrix') };
  } catch {
    unavailable = true;
    state = null;
  }
  return state;
}

export function glAvailable() {
  return !!setup();
}

// مصفوفة: المستطيل بأبعاد الجهاز يُدار حول X وY ثم يُسقط بمنظور على لوحة أوسع منه بهامش.
// نقية (تُختبر بـnode). العمود-أولاً كما يتوقع WebGL.
export function tiltMatrix(tiltX, tiltY, aspect, margin) {
  const rx = tiltX * Math.PI / 180, ry = tiltY * Math.PI / 180;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  // نقطة الجهاز (x·aspect, y, 0) ⇒ دوران Y ثم X ⇒ إزاحة إلى z = -distance ⇒ إسقاط.
  const distance = 4.5;
  const focal = distance / (1 + margin); // عند الإمالة صفر يملأ الجهاز 1/(1+margin) من اللوحة
  // أعمدة مصفوفة النموذج (دوران فقط، مع تحجيم x بنسبة العرض)
  const m = [
    cy * aspect, sx * sy * aspect, -cx * sy * aspect, 0,
    0, cx, sx, 0,
    sy, -sx * cy, cx * cy, 0,
    0, 0, -distance, 1,
  ];
  // إسقاط منظوري بسيط: x' = focal·x/aspect، y' = focal·y، w = -z
  const p = [
    focal / aspect, 0, 0, 0,
    0, focal, 0, 0,
    0, 0, -1.0002, -1,
    0, 0, -0.2, 0,
  ];
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += p[k * 4 + row] * m[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  // الجهاز المائل لا يتجاوز أثره وهو مستوٍ: المنظور يكبّر الطرف القريب، فنصغّر الإسقاط كله
  // بقدر ما يلزم كي تبقى الزوايا الأربع داخل مستطيل الجهاز الأصلي (وقع فعلاً: جهاز بحجم 84٪
  // وإمالة 22° تجاوز ارتفاع اللوحة).
  const flat = 1 / (1 + margin);
  let reach = flat;
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const w = out[3] * x + out[7] * y + out[15];
    reach = Math.max(reach, Math.abs((out[0] * x + out[4] * y + out[12]) / w), Math.abs((out[1] * x + out[5] * y + out[13]) / w));
  }
  const fit = flat / reach;
  for (const column of [0, 4, 8, 12]) { out[column] *= fit; out[column + 1] *= fit; }
  // المنظور غير متناظر: الطرف القريب أعرض فينزاح مركز الأثر. نعيد توسيطه بإزاحة في فضاء القص.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const w = out[3] * x + out[7] * y + out[15];
    const px = (out[0] * x + out[4] * y + out[12]) / w, py = (out[1] * x + out[5] * y + out[13]) / w;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const shiftX = -(minX + maxX) / 2, shiftY = -(minY + maxY) / 2;
  for (const column of [0, 4, 8, 12]) { out[column] += shiftX * out[column + 3]; out[column + 1] += shiftY * out[column + 3]; }
  return out;
}

// هامش صغير حول الجهاز لتنعيم الحواف؛ الإسقاط نفسه لا يتجاوز مستطيل الجهاز (انظر tiltMatrix).
export const TILT_MARGIN = 0.06;

// يرسم source (لوحة الجهاز) مائلاً على لوحة WebGL أوسع منه بهامش TILT_MARGIN من كل جهة.
// يعيد { canvas, margin } أو null إن لم يتوفر WebGL2. اللوحة المعادة مشتركة: تُنسخ فوراً.
export function tiltCanvas(source, tiltX, tiltY) {
  const context = setup();
  if (!context) return null;
  const { canvas, gl, texture, matrixLocation } = context;
  const width = Math.round(source.width * (1 + TILT_MARGIN * 2)), height = Math.round(source.height * (1 + TILT_MARGIN * 2));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  try {
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniformMatrix4fv(matrixLocation, false, tiltMatrix(tiltX, tiltY, source.width / source.height, TILT_MARGIN * 2));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.flush();
  } catch {
    return null;
  }
  if (gl.isContextLost()) { state = null; return null; }
  return { canvas, marginX: Math.round(source.width * TILT_MARGIN), marginY: Math.round(source.height * TILT_MARGIN) };
}
