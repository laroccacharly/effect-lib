// Minimal QR code encoder, fixed to what a tailnet URL needs: version 5 (37x37),
// error correction level L, byte mode, mask 0. Coordinates are `modules[y][x]`.

const size = 37
const dataCodewords = 108
const ecCodewords = 26
const alignmentCenter = 30

// Mode indicator (4 bits) and byte count (8 bits) precede the data.
export const maxQrBytes = dataCodewords - 2

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

const reedSolomonDivisor = (): Array<number> => {
  const divisor = Array.from({ length: ecCodewords }, (): number => 0)
  divisor[ecCodewords - 1] = 1
  let root = 1
  for (let i = 0; i < ecCodewords; i++) {
    for (let j = 0; j < ecCodewords; j++) divisor[j] = gfMultiply(divisor[j]!, root) ^ (divisor[j + 1] ?? 0)
    root = gfMultiply(root, 2)
  }
  return divisor
}

const errorCorrection = (data: ReadonlyArray<number>): Array<number> => {
  const divisor = reedSolomonDivisor()
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
const dataCodewordsFor = (bytes: Uint8Array): Array<number> => {
  const nibbles = [0b0100, ...[bytes.length, ...bytes].flatMap((byte) => [byte >>> 4, byte & 0xf]), 0b0000]
  const codewords = Array.from({ length: nibbles.length / 2 }, (_, i) => (nibbles[2 * i]! << 4) | nibbles[2 * i + 1]!)
  for (let pad = 0xec; codewords.length < dataCodewords; pad ^= 0xec ^ 0x11) codewords.push(pad)
  return codewords
}

class Matrix {
  readonly modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  readonly isFunction = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark
    this.isFunction[y]![x] = true
  }
}

const range = (from: number, to: number): Array<number> => Array.from({ length: to - from + 1 }, (_, i) => from + i)

const isInside = (x: number, y: number): boolean => x >= 0 && x < size && y >= 0 && y < size

// A square pattern of concentric rings; `isDark` gets the ring's distance from the center.
const drawRings = (matrix: Matrix, centerX: number, centerY: number, radius: number, isDark: (distance: number) => boolean) => {
  const offsets = range(-radius, radius).flatMap((dy) => range(-radius, radius).map((dx) => [dx, dy] as const))
  for (const [dx, dy] of offsets) {
    if (isInside(centerX + dx, centerY + dy)) matrix.set(centerX + dx, centerY + dy, isDark(Math.max(Math.abs(dx), Math.abs(dy))))
  }
}

const drawFunctionPatterns = (matrix: Matrix) => {
  for (let i = 0; i < size; i++) {
    matrix.set(6, i, i % 2 === 0)
    matrix.set(i, 6, i % 2 === 0)
  }
  const isFinderDark = (distance: number) => distance !== 2 && distance !== 4
  drawRings(matrix, 3, 3, 4, isFinderDark)
  drawRings(matrix, size - 4, 3, 4, isFinderDark)
  drawRings(matrix, 3, size - 4, 4, isFinderDark)
  drawRings(matrix, alignmentCenter, alignmentCenter, 2, (distance) => distance !== 1)
}

// Level L (01) with mask 0 (000), protected by a BCH(15,5) code and masked with 0x5412.
const formatBits = 0b111011111000100

const drawFormatBits = (matrix: Matrix) => {
  for (let i = 0; i <= 5; i++) matrix.set(8, i, bitAt(formatBits, i))
  matrix.set(8, 7, bitAt(formatBits, 6))
  matrix.set(8, 8, bitAt(formatBits, 7))
  matrix.set(7, 8, bitAt(formatBits, 8))
  for (let i = 9; i < 15; i++) matrix.set(14 - i, 8, bitAt(formatBits, i))
  for (let i = 0; i < 8; i++) matrix.set(size - 1 - i, 8, bitAt(formatBits, i))
  for (let i = 8; i < 15; i++) matrix.set(8, size - 15 + i, bitAt(formatBits, i))
  matrix.set(8, size - 8, true)
}

// Right columns of the two-module wide columns, from the right edge, skipping the vertical timing pattern.
const columnPairs = range(0, (size - 1) / 2 - 1).map((pair) => size - 1 - 2 * pair - Number(pair >= (size - 7) / 2))

// Rows of a column pair, alternately upward from the bottom and downward from the top.
const pairRows = (pairIndex: number): Array<number> => {
  if (pairIndex % 2 === 0) return range(0, size - 1).reverse()
  return range(0, size - 1)
}

// Module positions in placement order: zigzagging up and down two-module columns, right before left.
const zigzag = columnPairs.flatMap((right, pairIndex) => pairRows(pairIndex).flatMap((y) => [[right, y] as const, [right - 1, y] as const]))

const codewordBit = (codewords: ReadonlyArray<number>, index: number): boolean =>
  index < codewords.length * 8 && bitAt(codewords[index >>> 3]!, 7 - (index & 7))

// Fills the non-function modules in zigzag order with the codeword bits, applying mask 0.
const drawCodewords = (matrix: Matrix, codewords: ReadonlyArray<number>) => {
  const dataPositions = zigzag.filter(([x, y]) => !matrix.isFunction[y]![x])
  dataPositions.forEach(([x, y], index) => (matrix.modules[y]![x] = codewordBit(codewords, index) !== ((x + y) % 2 === 0)))
}

// The dark modules of a QR code for `bytes`, which must be at most `maxQrBytes` long.
export const qrMatrix = (bytes: Uint8Array): ReadonlyArray<ReadonlyArray<boolean>> => {
  const matrix = new Matrix()
  drawFunctionPatterns(matrix)
  drawFormatBits(matrix)
  const data = dataCodewordsFor(bytes)
  drawCodewords(matrix, [...data, ...errorCorrection(data)])
  return matrix.modules
}
