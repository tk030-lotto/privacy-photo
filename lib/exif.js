/**
 * PrivacyPhoto - 軽量オフラインExifパーサー (lib/exif.js)
 * 外部ライブラリなしでJPEG/PNG/WebP内のExifメタデータ（GPS、日時、機種、Orientation等）を解析する
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PrivacyExif = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * ArrayBufferからExifメタデータを解析する
   * @param {ArrayBuffer} buffer
   * @returns {Object} ExifParseResult
   */
  function parse(buffer) {
    const defaultResult = {
      hasExif: false,
      tagsCount: 0,
      hasGps: false,
      gpsDetails: null,
      hasDateTime: false,
      dateTimeStr: '',
      hasCameraModel: false,
      cameraModelStr: '',
      orientation: 1,
      make: '',
      model: '',
      software: '',
      exposureTime: '',
      fNumber: '',
      iso: '',
      focalLength: '',
      rawTags: {}
    };

    if (!buffer || buffer.byteLength < 16) {
      return defaultResult;
    }

    try {
      const dataView = new DataView(buffer);
      const isJpeg = dataView.getUint16(0, false) === 0xFFD8;

      if (isJpeg) {
        return parseJpegExif(dataView, defaultResult);
      }

      // PNGの場合: 'eXIf' チャンクの検出
      if (isPng(dataView)) {
        return parsePngExif(dataView, defaultResult);
      }

      // WebPの場合: 'EXIF' チャンクの検出
      if (isWebP(dataView)) {
        return parseWebPExif(dataView, defaultResult);
      }

      // その他の場合、バッファ全体から 'Exif\0\0' シグネチャを走査
      const signatureOffset = findExifSignature(dataView);
      if (signatureOffset !== -1) {
        return parseTiffHeader(dataView, signatureOffset + 6, defaultResult);
      }

      return defaultResult;
    } catch (e) {
      console.warn('Exif解析中に警告/例外が発生しました（安全に処理継続）:', e);
      return defaultResult;
    }
  }

  function isPng(view) {
    if (view.byteLength < 8) return false;
    return (
      view.getUint32(0, false) === 0x89504E47 &&
      view.getUint32(4, false) === 0x0D0A1A0A
    );
  }

  function isWebP(view) {
    if (view.byteLength < 12) return false;
    return (
      view.getUint32(0, false) === 0x52494646 && // RIFF
      view.getUint32(8, false) === 0x57454250    // WEBP
    );
  }

  function findExifSignature(view) {
    const maxScan = Math.min(view.byteLength - 6, 65536);
    for (let i = 0; i < maxScan; i++) {
      if (
        view.getUint8(i) === 0x45 &&     // E
        view.getUint8(i + 1) === 0x78 && // x
        view.getUint8(i + 2) === 0x69 && // i
        view.getUint8(i + 3) === 0x66 && // f
        view.getUint8(i + 4) === 0x00 &&
        view.getUint8(i + 5) === 0x00
      ) {
        return i;
      }
    }
    return -1;
  }

  function parseJpegExif(view, result) {
    let offset = 2;
    const length = view.byteLength;

    while (offset < length - 4) {
      if (view.getUint8(offset) !== 0xFF) {
        break;
      }

      // 0xFF 連続パディングをスキップ
      while (offset < length - 1 && view.getUint8(offset + 1) === 0xFF) {
        offset++;
      }

      if (offset >= length - 3) {
        break;
      }

      const marker = view.getUint8(offset + 1);
      // SOS (Start of Scan) または EOI (End of Image) に達したら探索終了
      if (marker === 0xDA || marker === 0xD9) {
        break;
      }

      // スタンドアロンマーカー（長さフィールドを持たないマーカー: RST0-7, TEM）
      if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
        offset += 2;
        continue;
      }

      const segmentLength = view.getUint16(offset + 2, false);
      // segmentLength は長さフィールド2バイトを含むため最小2。バッファ範囲超過やオーバーフローを防護
      if (segmentLength < 2 || offset + 2 + segmentLength > length) {
        break;
      }

      // APP1 マーカー (0xFFE1) かつ "Exif\0\0"
      if (marker === 0xE1) {
        if (segmentLength >= 8) {
          const isExif =
            view.getUint8(offset + 4) === 0x45 && // E
            view.getUint8(offset + 5) === 0x78 && // x
            view.getUint8(offset + 6) === 0x69 && // i
            view.getUint8(offset + 7) === 0x66 && // f
            view.getUint8(offset + 8) === 0x00 &&
            view.getUint8(offset + 9) === 0x00;

          if (isExif) {
            const tiffHeaderOffset = offset + 10;
            return parseTiffHeader(view, tiffHeaderOffset, result);
          }
        }
      }

      const nextOffset = offset + 2 + segmentLength;
      if (nextOffset <= offset) {
        break; // 前進しない異常値の防護
      }
      offset = nextOffset;
    }

    return result;
  }

  function parsePngExif(view, result) {
    let offset = 8;
    const length = view.byteLength;

    while (offset < length - 8) {
      const chunkLength = view.getUint32(offset, false);
      if (offset + 12 + chunkLength > length) {
        break;
      }
      const chunkType = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );

      if (chunkType === 'eXIf' && chunkLength >= 8) {
        return parseTiffHeader(view, offset + 8, result);
      }

      if (chunkType === 'IEND') break;
      const nextOffset = offset + 12 + chunkLength;
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }

    return result;
  }

  function parseWebPExif(view, result) {
    let offset = 12;
    const length = view.byteLength;

    while (offset < length - 8) {
      const chunkType = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const chunkLength = view.getUint32(offset + 4, true);
      const paddedLength = chunkLength + (chunkLength % 2); // 2バイトアラインメント
      if (offset + 8 + paddedLength > length) {
        break;
      }

      if (chunkType === 'EXIF' && chunkLength >= 8) {
        const headerOffset = offset + 8;
        // 先頭に Exif\0\0 が付いているか確認
        if (
          view.getUint8(headerOffset) === 0x45 &&
          view.getUint8(headerOffset + 1) === 0x78 &&
          view.getUint8(headerOffset + 2) === 0x69 &&
          view.getUint8(headerOffset + 3) === 0x66
        ) {
          return parseTiffHeader(view, headerOffset + 6, result);
        }
        return parseTiffHeader(view, headerOffset, result);
      }

      const nextOffset = offset + 8 + paddedLength;
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }

    return result;
  }

  function parseTiffHeader(view, tiffOffset, result) {
    if (tiffOffset + 8 > view.byteLength) {
      return result;
    }

    const byteOrderMarker = view.getUint16(tiffOffset, false);
    let littleEndian = false;
    if (byteOrderMarker === 0x4949) {
      littleEndian = true; // "II" (Intel)
    } else if (byteOrderMarker === 0x4D4D) {
      littleEndian = false; // "MM" (Motorola)
    } else {
      return result; // 不正なバイトオーダー
    }

    // 42 固定値
    const fixed42 = view.getUint16(tiffOffset + 2, littleEndian);
    if (fixed42 !== 0x002A) {
      return result;
    }

    const firstIfdOffset = view.getUint32(tiffOffset + 4, littleEndian);
    if (firstIfdOffset < 8 || tiffOffset + firstIfdOffset >= view.byteLength) {
      return result;
    }

    result.hasExif = true;

    // 0th IFD 解析
    const tags = {};
    let totalTagsCount = 0;
    const ifd0Result = parseIFD(view, tiffOffset, tiffOffset + firstIfdOffset, littleEndian, tags);
    totalTagsCount += ifd0Result.count;

    // 基本情報マッピング
    if (tags[0x0112]) { // Orientation
      result.orientation = tags[0x0112];
    }
    if (tags[0x010F]) { // Make
      result.make = String(tags[0x010F]).trim();
    }
    if (tags[0x0110]) { // Model
      result.model = String(tags[0x0110]).trim();
    }
    if (tags[0x0131]) { // Software
      result.software = String(tags[0x0131]).trim();
    }
    if (tags[0x0132]) { // DateTime
      result.dateTimeStr = String(tags[0x0132]).trim();
    }

    // Exif サブIFD
    const exifIfdPointer = tags[0x8769];
    if (exifIfdPointer && tiffOffset + exifIfdPointer < view.byteLength) {
      const exifTags = {};
      const subResult = parseIFD(view, tiffOffset, tiffOffset + exifIfdPointer, littleEndian, exifTags);
      totalTagsCount += subResult.count;
      Object.assign(tags, exifTags);

      if (exifTags[0x9003]) { // DateTimeOriginal
        result.dateTimeStr = String(exifTags[0x9003]).trim();
      } else if (exifTags[0x9004] && !result.dateTimeStr) { // DateTimeDigitized
        result.dateTimeStr = String(exifTags[0x9004]).trim();
      }

      if (exifTags[0x829A]) { // ExposureTime
        const exp = exifTags[0x829A];
        result.exposureTime = Array.isArray(exp) ? `${exp[0]}/${exp[1]}秒` : `${exp}秒`;
      }
      if (exifTags[0x829D]) { // FNumber
        const fn = exifTags[0x829D];
        result.fNumber = Array.isArray(fn) ? `f/${(fn[0] / fn[1]).toFixed(1)}` : `f/${fn}`;
      }
      if (exifTags[0x8827]) { // ISO
        result.iso = `ISO ${exifTags[0x8827]}`;
      }
      if (exifTags[0x920A]) { // FocalLength
        const fl = exifTags[0x920A];
        result.focalLength = Array.isArray(fl) ? `${(fl[0] / fl[1]).toFixed(1)} mm` : `${fl} mm`;
      }
    }

    // GPS サブIFD
    const gpsIfdPointer = tags[0x8825];
    if (gpsIfdPointer && tiffOffset + gpsIfdPointer < view.byteLength) {
      const gpsTags = {};
      const gpsResult = parseIFD(view, tiffOffset, tiffOffset + gpsIfdPointer, littleEndian, gpsTags);
      totalTagsCount += gpsResult.count;
      Object.assign(tags, gpsTags);

      const lat = gpsTags[0x0002];
      const latRef = gpsTags[0x0001] || 'N';
      const lon = gpsTags[0x0004];
      const lonRef = gpsTags[0x0003] || 'E';

      if (lat && lon && Array.isArray(lat) && Array.isArray(lon)) {
        const latitude = convertDMSToDD(lat, latRef);
        const longitude = convertDMSToDD(lon, lonRef);

        if (!isNaN(latitude) && !isNaN(longitude)) {
          result.hasGps = true;
          result.gpsDetails = {
            latitude,
            longitude,
            latRef,
            lonRef,
            altitude: null
          };

          if (gpsTags[0x0006]) {
            const alt = gpsTags[0x0006];
            result.gpsDetails.altitude = Array.isArray(alt) ? (alt[0] / alt[1]).toFixed(1) : alt;
          }
        }
      }
    }

    result.tagsCount = totalTagsCount;
    result.hasDateTime = Boolean(result.dateTimeStr);
    result.hasCameraModel = Boolean(result.make || result.model);
    result.cameraModelStr = [result.make, result.model].filter(Boolean).join(' ');
    result.rawTags = tags;

    return result;
  }

  function parseIFD(view, tiffOffset, ifdOffset, littleEndian, target) {
    if (ifdOffset + 2 > view.byteLength) return { count: 0 };
    const numEntries = view.getUint16(ifdOffset, littleEndian);
    let validCount = 0;

    for (let i = 0; i < numEntries; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > view.byteLength) break;

      const tagId = view.getUint16(entryOffset, littleEndian);
      const tagType = view.getUint16(entryOffset + 2, littleEndian);
      const count = view.getUint32(entryOffset + 4, littleEndian);
      const valueOffset = entryOffset + 8;

      const val = readTagValue(view, tiffOffset, tagType, count, valueOffset, littleEndian);
      if (val !== undefined && val !== null) {
        target[tagId] = val;
        validCount++;
      }
    }

    return { count: validCount };
  }

  const MAX_TAG_COUNT = 2048; // Exif規格の最大配列（TransferFunction等768件）を安全に許容し過大タグDoSを遮断

  function readTagValue(view, tiffOffset, type, count, valueOffset, littleEndian) {
    // 異常なcount値（過大タグ・非正値）は不正データとして安全にスキップ
    if (count > MAX_TAG_COUNT || count <= 0) {
      return null;
    }

    // タイプサイズ: 1: BYTE, 2: ASCII, 3: SHORT, 4: LONG, 5: RATIONAL, 7: UNDEFINED, 9: SLONG, 10: SRATIONAL
    const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const size = typeSizes[type] || 1;
    const totalBytes = size * count;

    let dataOffset = valueOffset;
    if (totalBytes > 4) {
      const pointer = view.getUint32(valueOffset, littleEndian);
      dataOffset = tiffOffset + pointer;
    }

    // 事前バッファ境界検証: count * size (totalBytes) がバッファ残量内に完全に収まることを確認
    if (dataOffset + totalBytes > view.byteLength || dataOffset < 0) {
      return null;
    }

    if (type === 2) { // ASCII 文字列
      let str = '';
      for (let i = 0; i < count; i++) {
        const charCode = view.getUint8(dataOffset + i);
        if (charCode === 0) break; // NULL終端
        str += String.fromCharCode(charCode);
      }
      return str;
    }

    if (type === 3) { // SHORT (16-bit unsigned)
      if (count === 1) return view.getUint16(dataOffset, littleEndian);
      const arr = [];
      for (let i = 0; i < count; i++) {
        arr.push(view.getUint16(dataOffset + i * 2, littleEndian));
      }
      return arr;
    }

    if (type === 4) { // LONG (32-bit unsigned)
      if (count === 1) return view.getUint32(dataOffset, littleEndian);
      const arr = [];
      for (let i = 0; i < count; i++) {
        arr.push(view.getUint32(dataOffset + i * 4, littleEndian));
      }
      return arr;
    }

    if (type === 5 || type === 10) { // RATIONAL (numerator / denominator)
      const readNum = (o) => (type === 10 ? view.getInt32(o, littleEndian) : view.getUint32(o, littleEndian));
      if (count === 1) {
        const num = readNum(dataOffset);
        const den = readNum(dataOffset + 4);
        return den === 0 ? 0 : [num, den];
      }
      const arr = [];
      for (let i = 0; i < count; i++) {
        const o = dataOffset + i * 8;
        const num = readNum(o);
        const den = readNum(o + 4);
        arr.push(den === 0 ? 0 : [num, den]);
      }
      return arr;
    }

    if (type === 1 || type === 7) { // BYTE / UNDEFINED
      if (count === 1) return view.getUint8(dataOffset);
      const arr = [];
      for (let i = 0; i < Math.min(count, 32); i++) {
        arr.push(view.getUint8(dataOffset + i));
      }
      return arr;
    }

    return null;
  }

  function convertDMSToDD(dmsArray, ref) {
    // dmsArray は [[degNum, degDen], [minNum, minDen], [secNum, secDen]] または [deg, min, sec]
    try {
      const getVal = (item) => {
        if (Array.isArray(item)) return item[1] === 0 ? 0 : item[0] / item[1];
        return typeof item === 'number' ? item : 0;
      };

      const deg = getVal(dmsArray[0]);
      const min = getVal(dmsArray[1]);
      const sec = getVal(dmsArray[2]);

      let dd = deg + min / 60 + sec / 3600;
      if (ref === 'S' || ref === 'W') {
        dd = -dd;
      }
      return parseFloat(dd.toFixed(6));
    } catch (e) {
      return NaN;
    }
  }

  return {
    parse: parse
  };
});
