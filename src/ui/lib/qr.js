// مرمّز QR نقي — صفر اعتماديات، لا DOM ولا شبكة.
// يُطبّق مواصفة QR Code Model 2 (ISO/IEC 18004) للبايت-مود UTF-8
// مع مستوى تصحيح الخطأ M واختيار أصغر نسخة تكفي النص.
//
// الواجهة الوحيدة: qrMatrix(text) -> boolean[][]   (true = وحدة سوداء)

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// عقوبات اختيار القناع (مواصفة §6.8.2.1)
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// بتّات مستوى تصحيح الخطأ لحقل الصيغة: L=1, M=0, Q=3, H=2
const ECL_FORMAT_BITS = 0;

// جداول المستوى M (الفهرس 0 للنسخة غير مستعمل)
const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const NUM_ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

/**
 * يُنتج مصفوفة QR كاملة للنص المعطى.
 * @param {string} text
 * @returns {boolean[][]}
 */
export function qrMatrix(text, forcedMask = -1) {
  const data = utf8Bytes(text);
  const version = chooseVersion(data.length);
  const dataCodewords = buildDataCodewords(data, version);
  const allCodewords = addEccAndInterleave(dataCodewords, version);
  const size = version * 4 + 17;

  const modules = createMatrix(size, false);
  const isFunction = createMatrix(size, false);

  drawFunctionPatterns(modules, isFunction, version);
  drawCodewords(modules, isFunction, allCodewords);
  const mask = forcedMask >= 0 ? forcedMask : chooseBestMask(modules, isFunction, version);
  applyMask(modules, isFunction, mask);
  drawFormatBits(modules, isFunction, version, mask);
  // معلومات النسخة تُرسم مرة واحدة مع النمط الوظيفي؛ لا تعتمد على القناع.

  return modules;
}

// ── اختيار النسخة ───────────────────────────────────────────────────────────

function chooseVersion(byteCount) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const dataBits = numDataCodewords(version) * 8;
    const neededBits = 4 + charCountBits(version) + byteCount * 8 + 4; // 4 بتات للمُنهي كحد أدنى
    if (neededBits <= dataBits) return version;
  }
  throw new RangeError('النص طويل جداً لأي نسخة QR');
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

// ── بناء كلمات البيانات ─────────────────────────────────────────────────────

function buildDataCodewords(data, version) {
  const bits = [];

  // مؤشر النمط: 0100 (بايت)
  appendBits(bits, 4, 0x4);
  // عدد البايتات
  appendBits(bits, charCountBits(version), data.length);
  // البيانات
  for (const b of data) appendBits(bits, 8, b);

  const capacityBits = numDataCodewords(version) * 8;

  // المُنهي 0000 (4 بتات كحد أقصى)
  appendBits(bits, Math.min(4, capacityBits - bits.length), 0);
  // تعبئة البتات حتى حدود البايت
  appendBits(bits, (8 - (bits.length % 8)) % 8, 0);

  // بايتات التعبئة المتناوبة 0xEC / 0x11
  for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) {
    appendBits(bits, 8, pad);
  }

  // تحويل البتات إلى بايتات بترتيب كبير
  const codewords = new Array(bits.length / 8).fill(0);
  for (let i = 0; i < bits.length; i++) {
    codewords[i >> 3] |= bits[i] << (7 - (i & 7));
  }
  return codewords;
}

function appendBits(bits, len, value) {
  for (let i = len - 1; i >= 0; i--) {
    bits.push((value >> i) & 1);
  }
}

// ── Reed–Solomon + ترتيب الكتل ──────────────────────────────────────────────

function addEccAndInterleave(data, version) {
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[version];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const rsDiv = reedSolomonDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const isShort = i < numShortBlocks;
    const datLen = shortBlockLen - blockEccLen + (isShort ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = reedSolomonRemainder(dat, rsDiv);
    if (isShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(blocks[j][i]);
      }
    }
  }
  return result;
}

function reedSolomonDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[result.length - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

// ── الرسم الوظيفي ───────────────────────────────────────────────────────────

function drawFunctionPatterns(modules, isFunction, version) {
  const size = modules.length;

  // خطوط التوقيت
  for (let i = 0; i < size; i++) {
    setFunction(modules, isFunction, 6, i, i % 2 === 0);
    setFunction(modules, isFunction, i, 6, i % 2 === 0);
  }

  // مربعات التموضع
  drawFinderPattern(modules, isFunction, 3, 3);
  drawFinderPattern(modules, isFunction, size - 4, 3);
  drawFinderPattern(modules, isFunction, 3, size - 4);

  // أنماط المحاذاة
  const positions = alignmentPatternPositions(version, size);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0)) continue;
      drawAlignmentPattern(modules, isFunction, positions[i], positions[j]);
    }
  }

  // الوحدة الداكنة الثابتة
  setFunction(modules, isFunction, 8, size - 8, true);

  // معلومات الصيغة (قناع مؤقت، يُكتب لاحقاً)
  drawFormatBits(modules, isFunction, version, 0);

  // معلومات النسخة (للنسخ 7 وما فوق)
  drawVersionInfo(modules, isFunction, version, size);
}

function drawFinderPattern(modules, isFunction, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (inBounds(modules, x, y)) {
        setFunction(modules, isFunction, x, y, dist !== 2 && dist !== 4);
      }
    }
  }
}

function drawAlignmentPattern(modules, isFunction, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      setFunction(modules, isFunction, cx + dx, cy + dy, dark);
    }
  }
}

function alignmentPatternPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

// ── معلومات الصيغة والنسخة ──────────────────────────────────────────────────

function drawFormatBits(modules, isFunction, version, mask) {
  const size = modules.length;
  const data = (ECL_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  // النسخة الأولى
  for (let i = 0; i <= 5; i++) setFunction(modules, isFunction, 8, i, getBit(bits, i));
  setFunction(modules, isFunction, 8, 7, getBit(bits, 6));
  setFunction(modules, isFunction, 8, 8, getBit(bits, 7));
  setFunction(modules, isFunction, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) setFunction(modules, isFunction, 14 - i, 8, getBit(bits, i));

  // النسخة الثانية
  for (let i = 0; i < 8; i++) setFunction(modules, isFunction, size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) setFunction(modules, isFunction, 8, size - 15 + i, getBit(bits, i));
  setFunction(modules, isFunction, 8, size - 8, true);
}

function drawVersionInfo(modules, isFunction, version, size) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  }
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(modules, isFunction, a, b, dark);
    setFunction(modules, isFunction, b, a, dark);
  }
}

// ── رسم كلمات البيانات ─────────────────────────────────────────────────────

function drawCodewords(modules, isFunction, codewords) {
  const size = modules.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = getBit(codewords[i >> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

// ── الأقنعة واختيار الأفضل ──────────────────────────────────────────────────

function applyMask(modules, isFunction, mask) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
        case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
        case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}

function chooseBestMask(modules, isFunction, version) {
  let bestMask = 0;
  let minPenalty = Infinity;
  const size = modules.length;
  // نعمل على نسخة حتى لا نلوّث المصفوفة الأصلية أثناء التقييم
  const scratch = modules.map((row) => row.slice());
  const scratchFunc = isFunction.map((row) => row.slice());

  for (let mask = 0; mask < 8; mask++) {
    applyMask(scratch, scratchFunc, mask);
    drawFormatBits(scratch, scratchFunc, version, mask);
    const penalty = computePenalty(scratch);
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = mask;
    }
    // نعكس القناع لاستعادة الحالة (XOR مرتين)
    applyMask(scratch, scratchFunc, mask);
    drawFormatBits(scratch, scratchFunc, version, 0);
  }
  return bestMask;
}

function computePenalty(modules) {
  const size = modules.length;
  let result = 0;

  // 1) تسلسل أفقي
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLen = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        finderPenaltyAddHistory(runLen, history, size);
        if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += finderPenaltyTerminateAndCount(runColor, runLen, history, size) * PENALTY_N3;
  }

  // 2) تسلسل عمودي
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLen = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        finderPenaltyAddHistory(runLen, history, size);
        if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += finderPenaltyTerminateAndCount(runColor, runLen, history, size) * PENALTY_N3;
  }

  // 3) مربعات 2×2 متجانسة
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  // 4) توازن اللون الداكن
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(0, k) * PENALTY_N4;

  return result;
}

function finderPenaltyAddHistory(currentRun, history, size) {
  if (history[0] === 0) currentRun += size;
  history.pop();
  history.unshift(currentRun);
}

function finderPenaltyTerminateAndCount(currentColor, currentRun, history, size) {
  if (currentColor) {
    finderPenaltyAddHistory(currentRun, history, size);
    currentRun = 0;
  }
  currentRun += size;
  finderPenaltyAddHistory(currentRun, history, size);
  return finderPenaltyCountPatterns(history);
}

function finderPenaltyCountPatterns(history) {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  if (!core) return 0;
  return ((history[0] >= n * 4 && history[6] >= n) ? 1 : 0)
       + ((history[6] >= n * 4 && history[0] >= n) ? 1 : 0);
}

// ── مساعدات عامة ───────────────────────────────────────────────────────────

function createMatrix(size, value) {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => value));
}

function inBounds(modules, x, y) {
  return x >= 0 && x < modules.length && y >= 0 && y < modules.length;
}

function setFunction(modules, isFunction, x, y, dark) {
  modules[y][x] = dark;
  isFunction[y][x] = true;
}

function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

function numDataCodewords(version) {
  return Math.floor(numRawDataModules(version) / 8)
       - ECC_CODEWORDS_PER_BLOCK[version] * NUM_ERROR_CORRECTION_BLOCKS[version];
}

function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function utf8Bytes(text) {
  const encoded = encodeURIComponent(text);
  const result = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded.charAt(i) === '%') {
      result.push(parseInt(encoded.substring(i + 1, i + 3), 16));
      i += 2;
    } else {
      result.push(encoded.charCodeAt(i));
    }
  }
  return result;
}
