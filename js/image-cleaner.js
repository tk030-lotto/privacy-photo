/**
 * PrivacyPhoto - 画像クリーン処理コアモジュール (js/image-cleaner.js)
 * Canvasを利用したExif除去、白背景合成、Orientation回転補正、再エンコード、安全再検証
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['../lib/exif'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../lib/exif'));
  } else {
    root.ImageCleaner = factory(root.PrivacyExif);
  }
})(typeof self !== 'undefined' ? self : this, function (PrivacyExif) {
  'use strict';

  /**
   * FileオブジェクトをImageオブジェクトとして読み込む
   * @param {File|Blob} fileOrBlob
   * @returns {Promise<{img: HTMLImageElement, url: string, width: number, height: number}>}
   */
  function loadImage(fileOrBlob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(fileOrBlob);
      const img = new Image();

      img.onload = () => {
        resolve({
          img: img,
          url: url,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height
        });
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('画像のデコードに失敗しました。対応形式（JPEG, PNG, WebP）であるかご確認ください。'));
      };

      img.src = url;
    });
  }


  /**
   * 画像からExifメタデータを除去し、白背景合成・再エンコードを行ってクリーンなJPEG Blobを生成する
   * ※モダンブラウザ（Chromium, Safari, Firefox等）は画像デコード時にExif Orientationを自動適用するため、
   * 手動回転を行うと二重回転（横倒しや逆さま）の原因になります。そのためブラウザの補正済み寸法をそのまま使用します。
   * @param {File|Blob} fileOrBlob
   * @param {number} quality (デフォルト: 0.92)
   * @returns {Promise<{blob: Blob, width: number, height: number, url: string}>}
   */
  async function cleanImage(fileOrBlob, quality = 0.92) {
    const loaded = await loadImage(fileOrBlob);
    const { img, url, width, height } = loaded;

    try {
      const canvas = document.createElement('canvas');

      // ブラウザが自動補正した解像度をそのままCanvasサイズとして設定
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        throw new Error('Canvas 2Dコンテキストの初期化に失敗しました。');
      }

      // 1. 透過PNG/WebPの黒塗り防止: 描画前に必ず純白（#FFFFFF）で下地を塗りつぶす
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);

      // 2. 元画像の描画（ブラウザによって既に正しい向きに展開されているため、そのまま等倍描画）
      ctx.drawImage(img, 0, 0, width, height);

      // 3. JPEG Blobの生成（Exifを含まない新規バイナリ）
      const cleanBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('JPEGエンコード処理に失敗しました。'));
            }
          },
          'image/jpeg',
          quality
        );
      });

      const cleanUrl = URL.createObjectURL(cleanBlob);

      return {
        blob: cleanBlob,
        width: width,
        height: height,
        url: cleanUrl
      };
    } finally {
      // ロード用一時URLの即時解放
      URL.revokeObjectURL(url);
    }
  }

  /**
   * 生成されたクリーンBlobをバイナリ解析し、Exifメタデータの有無を自律検証する
   * @param {Blob} blob
   * @returns {Promise<{isSafe: boolean, tagsCount: number, details: Object}>}
   */
  async function verifyCleanedBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const buffer = reader.result;
          const result = PrivacyExif.parse(buffer);
          // tagsCount === 0 かつ hasExif === false かつ hasGps === false
          const isSafe = !result.hasExif && result.tagsCount === 0 && !result.hasGps;
          resolve({
            isSafe: isSafe,
            tagsCount: result.tagsCount,
            details: result
          });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('生成画像の検証用読み込みに失敗しました。'));
      reader.readAsArrayBuffer(blob);
    });
  }

  return {
    loadImage: loadImage,
    cleanImage: cleanImage,
    verifyCleanedBlob: verifyCleanedBlob
  };
});
