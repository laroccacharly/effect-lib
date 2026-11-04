// Minimal QR code encoder for short text like a tailnet URL: byte mode, versions 1 to 5 with one error correction block,
// the strongest error correction level that fits, and the mask with the lowest penalty. Coordinates are `modules[y][x]`.

type Level = "L" | "M" | "Q" | "H"

interface Spec {
  readonly version: number
  readonly level: Level
  readonly dataCodewords: number
  readonly ecCodewords: number
}

// The versions and levels whose codewords form a single block, strongest level first, then smallest version.
const specs: ReadonlyArray<Spec> = [
  { version: 1, level: "H", dataCodewords: 9, ecCodewords: 17 },
  { version: 2, level: "H", dataCodewords: 16, ecCodewords: 28 },
  { version: 1, level: "Q", dataCodewords: 13, ecCodewords: 13 },
  { version: 2, level: "Q", dataCodewords: 22, ecCodewords: 22 },
  { version: 1, level: "M", dataCodewords: 16, ecCodewords: 10 },
  { version: 2, level: "M", dataCodewords: 28, ecCodewords: 16 },
  { version: 3, level: "M", dataCodewords: 44, ecCodewords: 26 },
  { version: 1, level: "L", dataCodewords: 19, ecCodewords: 7 },
  { version: 2, level: "L", dataCodewords: 34, ecCodewords: 10 },
  { version: 3, level: "L", dataCodewords: 55, ecCodewords: 15 },
  { version: 4, level: "L", dataCodewords: 80, ecCodewords: 20 },
  { version: 5, level: "L", dataCodewords: 108, ecCodewords: 26 },
]

// Mode indicator (4 bits), byte count (8 bits) and terminator (4 bits) take two codewords.
const capacity = (spec: Spec) => spec.dataCodewords - 2

export const maxQrBytes = Math.max(...specs.map(capacity))

const levelBits: Record<Level, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }

const bitAt = (value: number, index: number): boolean => ((value >>> index) & 1) === 1

// Multiplication in GF(256) modulo x^8 + x^4 + x^3 + x^2 + 1.
const gfMultiply = (x: number, y: number): number => {
  let product = 0
  for (let i = 7; i >= 0; i--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((y >>> i) & 1) * x
  }
  return product
}

const reedSolomonDivisor = (degree: number): Array<number> => {
  const divisor = Array.from({ length: degree }, (): number => 0)
  divisor[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) divisor[j] = gfMultiply(divisor[j]!, root) ^ (divisor[j + 1] ?? 0)
    root = gfMultiply(root, 2)
  }
  return divisor
}

const errorCorrection = (data: ReadonlyArray<number>, degree: number): Array<number> => {
  const divisor = reedSolomonDivisor(degree)
  const remainder = divisor.map(() => 0)
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!
    remainder.push(0)
    divisor.forEach((coefficient, i) => (remainder[i]! ^= gfMultiply(coefficient, factor)))
  }
  return remainder
}

// Byte mode (0100), the byte count, the bytes and a terminator (0000), then alternating pad bytes.
// The 12 bit header shifts everything by half a byte, so the stream is built from nibbles.
const dataCodewordsFor = (bytes: Uint8Array, spec: Spec): Array<number> => {
  const nibbles = [0b0100, ...[bytes.length, ...bytes].flatMap((byte) => [byte >>> 4, byte & 0xf]), 0b0000]
  const codewords = Array.from({ length: nibbles.length / 2 }, (_, i) => (nibbles[2 * i]! << 4) | nibbles[2 * i + 1]!)
  for (let pad = 0xec; codewords.length < spec.dataCodewords; pad ^= 0xec ^ 0x11) codewords.push(pad)
  return codewords
}

// The level and mask, protected by a BCH(15,5) code and masked with 0x5412.
const formatBits = (level: Level, mask: number): number => {
  const data = (levelBits[level] << 3) | mask
  let remainder = data
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412
}

const masks: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

class Matrix {
  readonly modules: Array<Array<boolean>>
  readonly isFunction: Array<Array<boolean>>
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
    this.isFunction = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark
    this.isFunction[y]![x] = true
  }
}

const range = (from: number, to: number): Array<number> => Array.from({ length: to - from + 1 }, (_, i) => from + i)

// A square pattern of concentric rings; `isDark` gets the ring's distance from the center.
const drawRings = (matrix: Matrix, centerX: number, centerY: number, radius: number, isDark: (distance: number) => boolean) => {
  const isInside = (x: number, y: number) => x >= 0 && x < matrix.size && y >= 0 && y < matrix.size
  const offsets = range(-radius, radius).flatMap((dy) => range(-radius, radius).map((dx) => [dx, dy] as const))
  for (const [dx, dy] of offsets) {
    if (isInside(centerX + dx, centerY + dy)) matrix.set(centerX + dx, centerY + dy, isDark(Math.max(Math.abs(dx), Math.abs(dy))))
  }
}

// Timing patterns, the three finders with their separators, and from version 2 one alignment pattern.
const drawFunctionPatterns = (matrix: Matrix, version: number) => {
  const size = matrix.size
  for (let i = 0; i < size; i++) {
    matrix.set(6, i, i % 2 === 0)
    matrix.set(i, 6, i % 2 === 0)
  }
  const isFinderDark = (distance: number) => distance !== 2 && distance !== 4
  drawRings(matrix, 3, 3, 4, isFinderDark)
  drawRings(matrix, size - 4, 3, 4, isFinderDark)
  drawRings(matrix, 3, size - 4, 4, isFinderDark)
  if (version >= 2) drawRings(matrix, size - 7, size - 7, 2, (distance) => distance !== 1)
}

const drawFormatBits = (matrix: Matrix, bits: number) => {
  const size = matrix.size
  for (let i = 0; i <= 5; i++) matrix.set(8, i, bitAt(bits, i))
  matrix.set(8, 7, bitAt(bits, 6))
  matrix.set(8, 8, bitAt(bits, 7))
  matrix.set(7, 8, bitAt(bits, 8))
  for (let i = 9; i < 15; i++) matrix.set(14 - i, 8, bitAt(bits, i))
  for (let i = 0; i < 8; i++) matrix.set(size - 1 - i, 8, bitAt(bits, i))
  for (let i = 8; i < 15; i++) matrix.set(8, size - 15 + i, bitAt(bits, i))
  matrix.set(8, size - 8, true)
}

// Module positions in placement order: zigzagging up and down two-module columns, right to left,
// skipping the vertical timing pattern; pairs alternate upward from the bottom and downward from the top.
const zigzag = (size: number) => {
  const columnPairs = range(0, (size - 1) / 2 - 1).map((pair) => size - 1 - 2 * pair - Number(pair >= (size - 7) / 2))
  const pairRows = (pairIndex: number) => {
    if (pairIndex % 2 === 0) return range(0, size - 1).reverse()
    return range(0, size - 1)
  }
  return columnPairs.flatMap((right, pairIndex) => pairRows(pairIndex).flatMap((y) => [[right, y] as const, [right - 1, y] as const]))
}

const codewordBit = (codewords: ReadonlyArray<number>, index: number): boolean =>
  index < codewords.length * 8 && bitAt(codewords[index >>> 3]!, 7 - (index & 7))

// Fills the non-function modules in zigzag order with the codeword bits, then the remainder bits, all masked.
const drawCodewords = (matrix: Matrix, codewords: ReadonlyArray<number>, mask: (x: number, y: number) => boolean) => {
  const dataPositions = zigzag(matrix.size).filter(([x, y]) => !matrix.isFunction[y]![x])
  dataPositions.forEach(([x, y], index) => (matrix.modules[y]![x] = codewordBit(codewords, index) !== mask(x, y)))
}

const build = (spec: Spec, codewords: ReadonlyArray<number>, mask: number): Matrix => {
  const matrix = new Matrix(17 + 4 * spec.version)
  drawFunctionPatterns(matrix, spec.version)
  drawFormatBits(matrix, formatBits(spec.level, mask))
  drawCodewords(matrix, codewords, masks[mask]!)
  return matrix
}

// Every row and every column, as lines of modules.
const linesOf = (modules: ReadonlyArray<ReadonlyArray<boolean>>) => [...modules, ...modules.map((_, x) => modules.map((row) => row[x]!))]

// Rule 1: runs of five or more modules of one color.
const runPenalty = (line: ReadonlyArray<boolean>) => {
  let penalty = 0
  let run = 1
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      run++
      continue
    }
    if (run >= 5) penalty += run - 2
    run = 1
  }
  return penalty
}

// Rule 3: patterns like a finder's, dark-light-dark-dark-dark-light-dark, beside four light modules.
const finderLike = ["10111010000", "00001011101"]
const finderPenalty = (line: ReadonlyArray<boolean>) => {
  const text = line.map(Number).join("")
  return finderLike.reduce((penalty, pattern) => penalty + 40 * (text.split(pattern).length - 1), 0)
}

// Rule 2: two-by-two blocks of one color.
const blockPenalty = (modules: ReadonlyArray<ReadonlyArray<boolean>>) =>
  range(0, modules.length - 2)
    .flatMap((y) => range(0, modules.length - 2).map((x) => [x, y] as const))
    .filter(([x, y]) => modules[y]![x] === modules[y]![x + 1] && modules[y]![x] === modules[y + 1]![x] && modules[y]![x] === modules[y + 1]![x + 1]).length * 3

// Rule 4: how far the share of dark modules is from half.
const balancePenalty = (modules: ReadonlyArray<ReadonlyArray<boolean>>) => {
  const total = modules.length ** 2
  const dark = modules.flat().filter(Boolean).length
  return (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
}

// The QR specification's penalty: the lower, the easier for a scanner.
const penalty = (modules: ReadonlyArray<ReadonlyArray<boolean>>) =>
  linesOf(modules).reduce((sum, line) => sum + runPenalty(line) + finderPenalty(line), 0) + blockPenalty(modules) + balancePenalty(modules)

// The dark modules of a QR code for `bytes`, which must be at most `maxQrBytes` long.
export const qrMatrix = (bytes: Uint8Array): ReadonlyArray<ReadonlyArray<boolean>> => {
  const spec = specs.find((candidate) => bytes.length <= capacity(candidate)) ?? specs[specs.length - 1]!
  const data = dataCodewordsFor(bytes, spec)
  const codewords = [...data, ...errorCorrection(data, spec.ecCodewords)]
  const candidates = masks.map((_, mask) => build(spec, codewords, mask).modules)
  const scores = candidates.map(penalty)
  return candidates[scores.indexOf(Math.min(...scores))]!
}
