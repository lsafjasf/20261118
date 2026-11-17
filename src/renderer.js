// WebGL2 renderer: uploads planar YUV420 data as three R8 textures and
// performs range de-quantization + YCbCr matrix conversion in one fragment
// shader. Clamping happens only after the matrix multiply (see clamp()).

import { coefficients } from './yuv.js';

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // Fullscreen triangle pair; flip Y so plane row 0 lands at the canvas top.
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_texY;
uniform sampler2D u_texU;
uniform sampler2D u_texV;
uniform float u_yScale;
uniform float u_yOffset;
uniform float u_cScale;
uniform float u_cOffset;
uniform float u_rFromCr;
uniform float u_gFromCb;
uniform float u_gFromCr;
uniform float u_bFromCb;
in vec2 v_uv;
out vec4 outColor;

vec3 nearestYuv(vec2 uv) {
  vec2 lumaSize = vec2(textureSize(u_texY, 0));
  vec2 chromaSize = vec2(textureSize(u_texU, 0));
  vec2 ly = (floor(uv * lumaSize) + 0.5) / lumaSize;
  vec2 lc = (floor(uv * chromaSize) + 0.5) / chromaSize;
  float y = texture(u_texY, ly).r;
  float cb = texture(u_texU, lc).r;
  float cr = texture(u_texV, lc).r;
  return vec3(y, cb, cr);
}

void main() {
  vec3 yuv = nearestYuv(v_uv);
  // De-quantize raw code values without pre-clamping: values outside the
  // nominal range retain their overshoot all the way into the matrix.
  float yVal = yuv.x * u_yScale + u_yOffset;
  float cb   = yuv.y * u_cScale + u_cOffset;
  float cr   = yuv.z * u_cScale + u_cOffset;

  float r = yVal + u_rFromCr * cr;
  float g = yVal - u_gFromCb * cb - u_gFromCr * cr;
  float b = yVal + u_bFromCb * cb;

  // Clamp only after the matrix multiply, never before.
  outColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

export class YuvRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.textures = ['u_texY', 'u_texU', 'u_texV'].map((name, i) => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, name), i);
      return tex;
    });

    this.uniforms = {
      yScale: gl.getUniformLocation(prog, 'u_yScale'),
      yOffset: gl.getUniformLocation(prog, 'u_yOffset'),
      cScale: gl.getUniformLocation(prog, 'u_cScale'),
      cOffset: gl.getUniformLocation(prog, 'u_cOffset'),
      rFromCr: gl.getUniformLocation(prog, 'u_rFromCr'),
      gFromCb: gl.getUniformLocation(prog, 'u_gFromCb'),
      gFromCr: gl.getUniformLocation(prog, 'u_gFromCr'),
      bFromCb: gl.getUniformLocation(prog, 'u_bFromCb'),
    };

    this.fbo = gl.createFramebuffer();
  }

  // Upload one plane. UNPACK_ROW_LENGTH lets a plane carry a stride larger
  // than its logical width without any row re-packing on the CPU side.
  uploadPlane(unit, plane, width, height, stride) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      width,
      height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      plane,
    );
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  setConversion(matrixName, range) {
    const gl = this.gl;
    const coeff = coefficients(matrixName);
    // GL texture values are code/255, so scale by 255 before applying the
    // same normalized-space formulas as the CPU reference.
    if (range === 'limited') {
      gl.uniform1f(this.uniforms.yScale, 255 / 219);
      gl.uniform1f(this.uniforms.yOffset, -16 / 219);
      gl.uniform1f(this.uniforms.cScale, 255 / 224);
      gl.uniform1f(this.uniforms.cOffset, -128 / 224);
    } else {
      gl.uniform1f(this.uniforms.yScale, 1.0);
      gl.uniform1f(this.uniforms.yOffset, 0.0);
      gl.uniform1f(this.uniforms.cScale, 1.0);
      gl.uniform1f(this.uniforms.cOffset, -128 / 255);
    }
    gl.uniform1f(this.uniforms.rFromCr, coeff.rFromCr);
    gl.uniform1f(this.uniforms.gFromCb, coeff.gFromCb);
    gl.uniform1f(this.uniforms.gFromCr, coeff.gFromCr);
    gl.uniform1f(this.uniforms.bFromCb, coeff.bFromCb);
  }

  render(frame, matrixName, range) {
    const gl = this.gl;
    const { width, height, strides, yPlane, uPlane, vPlane } = frame;
    this.uploadPlane(0, yPlane, width, height, strides.y);
    this.uploadPlane(1, uPlane, width / 2, height / 2, strides.c);
    this.uploadPlane(2, vPlane, width / 2, height / 2, strides.c);
    this.setConversion(matrixName, range);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Read the rendered frame back as tightly packed RGBA bytes.
  readPixels(width, height) {
    const gl = this.gl;
    const target = this.ensureReadTarget(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.activeTexture(gl.TEXTURE0 + 3);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      target,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('framebuffer incomplete');
    }
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // readPixels is bottom-up; flip rows so index 0 is the top row.
    const flipped = new Uint8Array(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      flipped.set(
        pixels.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes),
        y * rowBytes,
      );
    }
    gl.activeTexture(gl.TEXTURE0);
    return flipped;
  }

  ensureReadTarget(width, height) {
    const gl = this.gl;
    if (!this.readTarget) {
      this.readTarget = gl.createTexture();
      this.readSize = [0, 0];
    }
    gl.activeTexture(gl.TEXTURE0 + 3);
    gl.bindTexture(gl.TEXTURE_2D, this.readTarget);
    if (this.readSize[0] !== width || this.readSize[1] !== height) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.readSize = [width, height];
    }
    gl.activeTexture(gl.TEXTURE0);
    return this.readTarget;
  }
}
