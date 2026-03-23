function clamp01(value) {
  if (state.wasm && typeof state.wasm.clamp01 === 'function') {
    return state.wasm.clamp01(value)
  }
  return Math.max(0, Math.min(1, Number(value) || 0))
}


function mix(a, b, t) {
  if (state.wasm && typeof state.wasm.mix === 'function') {
    return state.wasm.mix(a, b, t)
  }
  return a + (b - a) * t
}


function distance3(a, b) {
  if (state.wasm && typeof state.wasm.distance3 === 'function') {
    return state.wasm.distance3(a[0], a[1], a[2], b[0], b[1], b[2])
  }
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}


function quatDotAbs(a, b) {
  if (state.wasm && typeof state.wasm.quatDotAbs4 === 'function') {
    return Math.min(1, Math.abs(state.wasm.quatDotAbs4(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3])))
  }
  return Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))
}


function rgbToLuma(r, g, b) {
  if (state.wasm && typeof state.wasm.rgbToLuma3 === 'function') {
    return state.wasm.rgbToLuma3(r, g, b)
  }
  return r * 0.299 + g * 0.587 + b * 0.114
}


function gradientEnergy(left, right, up, down) {
  if (state.wasm && typeof state.wasm.gradientEnergy4 === 'function') {
    return state.wasm.gradientEnergy4(left, right, up, down)
  }
  return Math.abs(right - left) + Math.abs(down - up)
}


function cornerScore(left, right, up, down, d1, d2, d3, d4) {
  if (state.wasm && typeof state.wasm.cornerScore8 === 'function') {
    return state.wasm.cornerScore8(left, right, up, down, d1, d2, d3, d4)
  }
  return Math.abs(right - left) + Math.abs(down - up) + 0.7 * Math.abs(d2 - d1) + 0.7 * Math.abs(d4 - d3)
}


function descriptorDistance4(a, b) {
  if (state.wasm && typeof state.wasm.descriptorDistance4 === 'function') {
    return state.wasm.descriptorDistance4(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3])
  }
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3])
}


function multiplyMatrix4(a, b) {
  const out = new Array(16).fill(0)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) {
        sum += a[row + k * 4] * b[k + column * 4]
      }
      out[row + column * 4] = sum
    }
  }
  return out
}


function transposeTimesMatrix(rows, cols, matrix) {
  const out = Array.from({ length: cols }, () => new Array(cols).fill(0))
  for (let row = 0; row < rows; row += 1) {
    const rowOffset = row * cols
    for (let i = 0; i < cols; i += 1) {
      const a = matrix[rowOffset + i]
      for (let j = 0; j < cols; j += 1) {
        out[i][j] += a * matrix[rowOffset + j]
      }
    }
  }
  return out
}


function transposeTimesVector(rows, cols, matrix, vector) {
  const out = new Array(cols).fill(0)
  for (let row = 0; row < rows; row += 1) {
    const rowOffset = row * cols
    const value = vector[row]
    for (let col = 0; col < cols; col += 1) {
      out[col] += matrix[rowOffset + col] * value
    }
  }
  return out
}


function solveLinearSystem(matrix, vector) {
  const n = vector.length
  const a = matrix.map((row, index) => row.slice(0, n).concat(vector[index]))
  for (let pivot = 0; pivot < n; pivot += 1) {
    let bestRow = pivot
    let bestValue = Math.abs(a[pivot][pivot])
    for (let row = pivot + 1; row < n; row += 1) {
      const value = Math.abs(a[row][pivot])
      if (value > bestValue) {
        bestValue = value
        bestRow = row
      }
    }
    if (bestValue < 1e-8) {
      return null
    }
    if (bestRow !== pivot) {
      const temp = a[pivot]
      a[pivot] = a[bestRow]
      a[bestRow] = temp
    }
    const pivotValue = a[pivot][pivot]
    for (let col = pivot; col <= n; col += 1) {
      a[pivot][col] /= pivotValue
    }
    for (let row = 0; row < n; row += 1) {
      if (row === pivot) {
        continue
      }
      const factor = a[row][pivot]
      if (!factor) {
        continue
      }
      for (let col = pivot; col <= n; col += 1) {
        a[row][col] -= factor * a[pivot][col]
      }
    }
  }
  return a.map((row) => row[n])
}


function rgbaToGray(rgba, width, height) {
  const pixelCount = width * height
  const gray = new Uint8Array(pixelCount)
  let brightnessSum = 0
  let brightnessSqSum = 0
  for (let srcIndex = 0, pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1, srcIndex += 4) {
    const luminance = Math.round(rgbToLuma(rgba[srcIndex], rgba[srcIndex + 1], rgba[srcIndex + 2]))
    gray[pixelIndex] = luminance
    brightnessSum += luminance
    brightnessSqSum += luminance * luminance
  }
  return { gray, brightnessSum, brightnessSqSum, pixelCount }
}

