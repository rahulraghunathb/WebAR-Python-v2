(function (global) {
  const SECTION = {
    type: 1,
    func: 3,
    export: 7,
    code: 10,
  }

  const VALUE_TYPE_F32 = 0x7d
  const EXPORT_KIND_FUNC = 0x00

  const OPCODE = {
    end: 0x0b,
    localGet: 0x20,
    f32Const: 0x43,
    f32Abs: 0x8b,
    f32Sqrt: 0x91,
    f32Add: 0x92,
    f32Sub: 0x93,
    f32Mul: 0x94,
    f32Min: 0x96,
    f32Max: 0x97,
  }

  function encodeU32(value) {
    const bytes = []
    let current = Number(value >>> 0)
    do {
      let byte = current & 0x7f
      current >>>= 7
      if (current !== 0) {
        byte |= 0x80
      }
      bytes.push(byte)
    } while (current !== 0)
    return bytes
  }

  function encodeF32(value) {
    const buffer = new ArrayBuffer(4)
    const view = new DataView(buffer)
    view.setFloat32(0, Number(value), true)
    return Array.from(new Uint8Array(buffer))
  }

  function encodeVector(items) {
    const flattened = []
    for (const item of items) {
      flattened.push(...item)
    }
    return [...encodeU32(items.length), ...flattened]
  }

  function encodeString(value) {
    const bytes = Array.from(new TextEncoder().encode(value))
    return [...encodeU32(bytes.length), ...bytes]
  }

  function encodeSection(sectionId, payload) {
    return [sectionId, ...encodeU32(payload.length), ...payload]
  }

  function encodeFunctionType(params, results) {
    return [0x60, ...encodeVector(params.map((value) => [value])), ...encodeVector(results.map((value) => [value]))]
  }

  function localGet(index) {
    return [OPCODE.localGet, ...encodeU32(index)]
  }

  function f32Const(value) {
    return [OPCODE.f32Const, ...encodeF32(value)]
  }

  function encodeBody(instructions) {
    const body = [0x00, ...instructions, OPCODE.end]
    return [...encodeU32(body.length), ...body]
  }

  function encodeExport(name, index) {
    return [...encodeString(name), EXPORT_KIND_FUNC, ...encodeU32(index)]
  }

  function absDiff(aIndex, bIndex) {
    return [...localGet(aIndex), ...localGet(bIndex), OPCODE.f32Sub, OPCODE.f32Abs]
  }

  function buildPoseKernelModuleBytes() {
    const type3 = encodeFunctionType([VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32], [VALUE_TYPE_F32])
    const type1 = encodeFunctionType([VALUE_TYPE_F32], [VALUE_TYPE_F32])
    const type6 = encodeFunctionType([VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32], [VALUE_TYPE_F32])
    const type8 = encodeFunctionType([VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32], [VALUE_TYPE_F32])
    const type4 = encodeFunctionType([VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32, VALUE_TYPE_F32], [VALUE_TYPE_F32])

    const typeSection = encodeSection(SECTION.type, encodeVector([type3, type1, type6, type8, type4]))
    const functionSection = encodeSection(
      SECTION.func,
      encodeVector([
        encodeU32(0),
        encodeU32(1),
        encodeU32(2),
        encodeU32(3),
        encodeU32(0),
        encodeU32(4),
        encodeU32(3),
        encodeU32(3),
      ])
    )

    const exportSection = encodeSection(
      SECTION.export,
      encodeVector([
        encodeExport('mix', 0),
        encodeExport('clamp01', 1),
        encodeExport('distance3', 2),
        encodeExport('quatDotAbs4', 3),
        encodeExport('rgbToLuma3', 4),
        encodeExport('gradientEnergy4', 5),
        encodeExport('cornerScore8', 6),
        encodeExport('descriptorDistance4', 7),
      ])
    )

    const mixBody = encodeBody([
      ...localGet(0),
      ...localGet(1),
      ...localGet(0),
      OPCODE.f32Sub,
      ...localGet(2),
      OPCODE.f32Mul,
      OPCODE.f32Add,
    ])

    const clampBody = encodeBody([
      ...localGet(0),
      ...f32Const(0),
      OPCODE.f32Max,
      ...f32Const(1),
      OPCODE.f32Min,
    ])

    const distanceBody = encodeBody([
      ...localGet(0), ...localGet(3), OPCODE.f32Sub, ...localGet(0), ...localGet(3), OPCODE.f32Sub, OPCODE.f32Mul,
      ...localGet(1), ...localGet(4), OPCODE.f32Sub, ...localGet(1), ...localGet(4), OPCODE.f32Sub, OPCODE.f32Mul, OPCODE.f32Add,
      ...localGet(2), ...localGet(5), OPCODE.f32Sub, ...localGet(2), ...localGet(5), OPCODE.f32Sub, OPCODE.f32Mul, OPCODE.f32Add,
      OPCODE.f32Sqrt,
    ])

    const quatDotBody = encodeBody([
      ...localGet(0), ...localGet(4), OPCODE.f32Mul,
      ...localGet(1), ...localGet(5), OPCODE.f32Mul, OPCODE.f32Add,
      ...localGet(2), ...localGet(6), OPCODE.f32Mul, OPCODE.f32Add,
      ...localGet(3), ...localGet(7), OPCODE.f32Mul, OPCODE.f32Add,
      OPCODE.f32Abs,
    ])

    const rgbToLumaBody = encodeBody([
      ...localGet(0), ...f32Const(0.299), OPCODE.f32Mul,
      ...localGet(1), ...f32Const(0.587), OPCODE.f32Mul, OPCODE.f32Add,
      ...localGet(2), ...f32Const(0.114), OPCODE.f32Mul, OPCODE.f32Add,
    ])

    const gradientBody = encodeBody([
      ...absDiff(1, 0),
      ...absDiff(3, 2),
      OPCODE.f32Add,
    ])

    const cornerBody = encodeBody([
      ...absDiff(1, 0),
      ...absDiff(3, 2), OPCODE.f32Add,
      ...absDiff(5, 4), ...f32Const(0.7), OPCODE.f32Mul, OPCODE.f32Add,
      ...absDiff(7, 6), ...f32Const(0.7), OPCODE.f32Mul, OPCODE.f32Add,
    ])

    const descriptorDistanceBody = encodeBody([
      ...absDiff(0, 4),
      ...absDiff(1, 5), OPCODE.f32Add,
      ...absDiff(2, 6), OPCODE.f32Add,
      ...absDiff(3, 7), OPCODE.f32Add,
    ])

    const codeSection = encodeSection(
      SECTION.code,
      encodeVector([mixBody, clampBody, distanceBody, quatDotBody, rgbToLumaBody, gradientBody, cornerBody, descriptorDistanceBody])
    )

    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00,
      ...typeSection,
      ...functionSection,
      ...exportSection,
      ...codeSection,
    ])
  }

  global.buildPoseKernelModuleBytes = buildPoseKernelModuleBytes
})(typeof self !== 'undefined' ? self : window)
