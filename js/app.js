/**
 * PrivacyPhoto - UIコントローラー (js/app.js)
 * 状態遷移、イベント制御、画面描画、ダウンロード、リセット管理
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // 内部状態
  const state = {
    file: null,
    exifData: null,
    originalImageUrl: null,
    originalWidth: 0,
    originalHeight: 0,
    cleanBlob: null,
    cleanImageUrl: null,
    cleanedFileName: '',
    isProcessing: false,
    analysisRunId: 0
  };

  // DOM要素の参照
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const alertContainer = document.getElementById('alert-container');

  // セクション
  const uploadSection = document.getElementById('upload-section');
  const analysisSection = document.getElementById('analysis-section');
  const processingSection = document.getElementById('processing-section');
  const resultSection = document.getElementById('result-section');

  // 解析結果要素
  const riskBadge = document.getElementById('risk-badge');
  const riskMessage = document.getElementById('risk-message');
  const gpsInfoCard = document.getElementById('gps-info-card');
  const gpsCoordinates = document.getElementById('gps-coordinates');
  const gpsMapLink = document.getElementById('gps-map-link');
  const gpsAltitude = document.getElementById('gps-altitude');
  const metaDatetime = document.getElementById('meta-datetime');
  const metaCamera = document.getElementById('meta-camera');
  const metaOrientation = document.getElementById('meta-orientation');
  const metaSoftware = document.getElementById('meta-software');
  const metaTechDetails = document.getElementById('meta-tech-details');
  const originalPreviewImg = document.getElementById('original-preview-img');
  const originalSizeLabel = document.getElementById('original-size-label');

  // アクションボタン
  const cleanButton = document.getElementById('clean-button');
  const downloadButton = document.getElementById('download-button');
  const resetButton = document.getElementById('reset-button');
  const reselectButton = document.getElementById('reselect-button');

  // 結果要素
  const safetyBadge = document.getElementById('safety-badge');
  const safetyDetails = document.getElementById('safety-details');
  const sizeBeforeLabel = document.getElementById('size-before-label');
  const sizeAfterLabel = document.getElementById('size-after-label');
  const sizeDiffLabel = document.getElementById('size-diff-label');
  const resBeforeLabel = document.getElementById('res-before-label');
  const resAfterLabel = document.getElementById('res-after-label');
  const cleanedPreviewImg = document.getElementById('cleaned-preview-img');

  // ==========================================
  // イベントリスナー設定
  // ==========================================

  // ドラッグ＆ドロップ
  ['dragenter', 'dragover'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-active');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-active');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
      handleFileSelection(dt.files[0]);
    }
  });

  // ドロップゾーン全体のクリック対応（ラベル・input自身のクリック時は二重発火を回避）
  dropZone.addEventListener('click', (e) => {
    if (e.target !== fileInput && !e.target.closest('label')) {
      fileInput.click();
    }
  });

  // キーボード操作対応 (a11y)
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  // ファイルダイアログ選択
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelection(e.target.files[0]);
    }
  });

  // ボタンイベント
  cleanButton.addEventListener('click', handleExecuteClean);
  downloadButton.addEventListener('click', handleDownload);
  resetButton.addEventListener('click', handleReset);
  reselectButton.addEventListener('click', handleReset);

  // ==========================================
  // ファイル処理・バリデーション
  // ==========================================

  async function handleFileSelection(file) {
    if (state.isProcessing) return;
    clearAlerts();

    if (!file) return;

    // 0バイトチェック
    if (file.size === 0) {
      showAlert('danger', 'ファイルが空（0バイト）です。有効な画像ファイルを選択してください。');
      return;
    }

    // 50MB上限チェック（DoS・メモリ枯渇防止）
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    if (file.size > MAX_FILE_SIZE) {
      showAlert('danger', 'ファイルサイズが大きすぎます（最大50MB）。50MB以下の写真を選択してください。');
      return;
    }

    const fileNameLower = file.name.toLowerCase();

    // HEIC / HEIF 形式の親切な案内
    if (fileNameLower.endsWith('.heic') || fileNameLower.endsWith('.heif') || file.type === 'image/heic') {
      showAlert(
        'warning',
        'iPhoneの「HEIC形式」はブラウザの直接処理に対応していません。iPhoneの設定（「設定」>「カメラ」>「フォーマット」）で「互換性優先」に設定して撮影したJPEG写真、またはJPEG/PNG形式に変換した画像をご利用ください。'
      );
      return;
    }

    // 対応MIMEタイプ検証
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const hasValidExt = /\.(jpe?g|png|webp)$/i.test(fileNameLower);

    if (!validTypes.includes(file.type) && !hasValidExt) {
      showAlert('danger', '対応していないファイル形式です。JPEG、PNG、WebP形式の写真を選択してください。');
      return;
    }

    // 状態のクリーンアップ
    cleanupUrls();
    state.file = file;
    const currentRunId = ++state.analysisRunId;

    // 解析中表示
    setSectionState('analyzing');

    try {
      const buffer = await readFileAsArrayBuffer(file);
      if (currentRunId !== state.analysisRunId) return;
      const exifResult = PrivacyExif.parse(buffer);
      state.exifData = exifResult;

      // 元画像プレビューURL作成
      state.originalImageUrl = URL.createObjectURL(file);

      // プレビュー画像のロード待機と解像度取得
      await new Promise((resolve) => {
        originalPreviewImg.onload = () => {
          state.originalWidth = originalPreviewImg.naturalWidth;
          state.originalHeight = originalPreviewImg.naturalHeight;
          resolve();
        };
        originalPreviewImg.onerror = () => {
          console.warn('プレビュー画像の描画に失敗しました。');
          state.originalWidth = 0;
          state.originalHeight = 0;
          resolve();
        };
        originalPreviewImg.src = state.originalImageUrl;
      });
      if (currentRunId !== state.analysisRunId) return;

      // 画面への描画
      renderAnalysisResult(file, exifResult);
      setSectionState('analyzed');
    } catch (err) {
      if (currentRunId !== state.analysisRunId) return;
      console.error('画像解析エラー:', err);
      showAlert('danger', `画像の読み込み・解析に失敗しました: ${err.message || '不明なエラー'}`);
      setSectionState('initial');
    }
  }

  // ==========================================
  // 解析結果の描画
  // ==========================================

  function renderAnalysisResult(file, exif) {
    originalSizeLabel.textContent = formatBytes(file.size);

    // GPS判定
    if (exif.hasGps && exif.gpsDetails) {
      riskBadge.className = 'status-badge badge-danger';
      riskBadge.textContent = '🚨 位置情報（GPS）を検出';
      riskMessage.textContent = '写真に正確な撮影位置情報（緯度・経度）が含まれています。SNS等へ投稿する前に除去することを推奨します。';

      gpsInfoCard.style.display = 'block';
      const lat = exif.gpsDetails.latitude;
      const lon = exif.gpsDetails.longitude;
      const latLabel = (exif.gpsDetails.latRef === 'S' || lat < 0) ? '南緯' : '北緯';
      const lonLabel = (exif.gpsDetails.lonRef === 'W' || lon < 0) ? '西経' : '東経';
      gpsCoordinates.textContent = `${latLabel} ${Math.abs(lat)}°, ${lonLabel} ${Math.abs(lon)}° (${lat}, ${lon})`;

      gpsMapLink.href = `https://www.google.com/maps?q=${lat},${lon}`;
      gpsMapLink.target = '_blank';
      gpsMapLink.rel = 'noopener noreferrer';
      gpsMapLink.style.display = 'inline-flex';

      if (exif.gpsDetails.altitude !== null) {
        gpsAltitude.textContent = `高度: 約 ${exif.gpsDetails.altitude} m`;
        gpsAltitude.style.display = 'inline-block';
      } else {
        gpsAltitude.style.display = 'none';
      }
    } else if (exif.hasExif && exif.tagsCount > 0) {
      riskBadge.className = 'status-badge badge-warning';
      riskBadge.textContent = '⚠️ メタデータを検出（GPSなし）';
      riskMessage.textContent = '位置情報は含まれていませんが、撮影日時やカメラ機種名などのメタデータが含まれています。';
      gpsInfoCard.style.display = 'none';
    } else if (exif.parseError) {
      riskBadge.className = 'status-badge badge-warning';
      riskBadge.textContent = '⚠️ Exif解析警告（除去可能）';
      riskMessage.textContent = 'Exif構造の一部が破損または非標準のため詳細を読み取れませんでした。そのまま除去処理を実行してクリーンな画像を生成できます。';
      gpsInfoCard.style.display = 'none';
    } else {
      riskBadge.className = 'status-badge badge-safe';
      riskBadge.textContent = 'Exif メタデータは検出されませんでした';
      riskMessage.textContent = 'この写真にはExifメタデータや位置情報は検出されませんでした（XMP等の他メタデータ除去や再エンコードのために除去処理を実行することも可能です）。';
      gpsInfoCard.style.display = 'none';
    }

    // 撮影日時
    metaDatetime.textContent = exif.dateTimeStr ? exif.dateTimeStr : '未記録';

    // カメラ機種
    metaCamera.textContent = exif.cameraModelStr ? exif.cameraModelStr : '未記録';

    // 向き補正
    const orientationMap = {
      1: '通常（0°）',
      2: '水平反転（自動補正対象）',
      3: '180°回転（自動補正対象）',
      4: '垂直反転（自動補正対象）',
      5: '90°反時計＋水平反転（自動補正対象）',
      6: '90°時計回り（自動補正対象）',
      7: '90°時計＋水平反転（自動補正対象）',
      8: '90°反時計回り（自動補正対象）'
    };
    metaOrientation.textContent = orientationMap[exif.orientation] || `値: ${exif.orientation}`;

    // 撮影パラメータ
    const techParts = [];
    if (exif.exposureTime) techParts.push(`露出: ${exif.exposureTime}`);
    if (exif.fNumber) techParts.push(`絞り: ${exif.fNumber}`);
    if (exif.iso) techParts.push(`感度: ${exif.iso}`);
    if (exif.focalLength) techParts.push(`焦点距離: ${exif.focalLength}`);
    metaTechDetails.textContent = techParts.length > 0 ? techParts.join(' / ') : 'なし';

    // ソフトウェア
    metaSoftware.textContent = exif.software ? exif.software : 'なし';
  }

  // ==========================================
  // メタデータ除去実行
  // ==========================================

  async function handleExecuteClean() {
    if (!state.file || state.isProcessing) return;

    state.isProcessing = true;
    cleanButton.disabled = true;
    setSectionState('processing');

    try {
      // Canvasによる白背景合成・Orientation補正・Exif除去クリーンJPEG生成
      const cleanResult = await ImageCleaner.cleanImage(state.file, 0.92);
      state.cleanBlob = cleanResult.blob;
      state.cleanImageUrl = cleanResult.url;

      // 出力ファイル名決定（ドット始まり等で空になる場合は photo にフォールバック）
      const originalBaseName = state.file.name.replace(/\.[^/.]+$/, '') || 'photo';
      state.cleanedFileName = `${originalBaseName}_clean.jpg`;

      // 除去後Blobの自律再検証
      const verifyResult = await ImageCleaner.verifyCleanedBlob(cleanResult.blob);

      // 結果画面の描画
      renderResultView(cleanResult, verifyResult);
      setSectionState('completed');
    } catch (err) {
      console.error('除去処理エラー:', err);
      showAlert('danger', `メタデータ除去処理に失敗しました: ${err.message || '不明なエラー'}`);
      setSectionState('analyzed');
    } finally {
      state.isProcessing = false;
      cleanButton.disabled = false;
    }
  }

  // ==========================================
  // 結果描画
  // ==========================================

  function renderResultView(cleanResult, verifyResult) {
    cleanedPreviewImg.src = cleanResult.url;

    // 安全確証バッジ
    if (verifyResult.isSafe) {
      safetyBadge.className = 'status-badge badge-safe';
      safetyBadge.textContent = 'Exif メタデータは検出されませんでした';
      safetyDetails.textContent = '再解析の結果、Exifメタデータ(GPS・撮影日時など)は検出されませんでした。';
    } else {
      safetyBadge.className = 'status-badge badge-warning';
      safetyBadge.textContent = '⚠ 一部タグ検出（要確認）';
      safetyDetails.textContent = `生成された画像に ${verifyResult.tagsCount} 件のタグが残存しています。`;
    }

    // ファイル容量比較
    const beforeSize = state.file.size;
    const afterSize = cleanResult.blob.size;
    sizeBeforeLabel.textContent = formatBytes(beforeSize);
    sizeAfterLabel.textContent = formatBytes(afterSize);

    const diffPercent = Math.round(((afterSize - beforeSize) / beforeSize) * 100);
    if (diffPercent < 0) {
      sizeDiffLabel.textContent = `${diffPercent}% 削減`;
      sizeDiffLabel.className = 'stat-badge stat-reduced';
    } else {
      sizeDiffLabel.textContent = `+${diffPercent}%`;
      sizeDiffLabel.className = 'stat-badge stat-increased';
    }

    // 解像度比較
    const beforeWidth = state.originalWidth || originalPreviewImg.naturalWidth || 0;
    const beforeHeight = state.originalHeight || originalPreviewImg.naturalHeight || 0;
    resBeforeLabel.textContent = (beforeWidth && beforeHeight) ? `${beforeWidth} × ${beforeHeight} px` : '取得中...';
    resAfterLabel.textContent = `${cleanResult.width} × ${cleanResult.height} px`;

    // 処理後プレビューのエラーハンドリング
    cleanedPreviewImg.onerror = () => {
      console.warn('処理後画像のプレビュー描画に失敗しました。');
      showAlert('warning', 'プレビュー画像の表示に失敗しました。画像の生成・ダウンロードは可能です。');
    };
  }

  // ==========================================
  // ダウンロード処理
  // ==========================================

  function handleDownload() {
    if (!state.cleanImageUrl || !state.cleanedFileName) return;

    const a = document.createElement('a');
    a.href = state.cleanImageUrl;
    a.download = state.cleanedFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ==========================================
  // リセット処理
  // ==========================================

  function handleReset() {
    cleanupUrls();
    state.file = null;
    state.exifData = null;
    state.originalWidth = 0;
    state.originalHeight = 0;
    state.cleanBlob = null;
    state.cleanedFileName = '';

    fileInput.value = '';
    originalPreviewImg.src = '';
    cleanedPreviewImg.src = '';

    clearAlerts();
    setSectionState('initial');
  }

  function cleanupUrls() {
    if (state.originalImageUrl) {
      URL.revokeObjectURL(state.originalImageUrl);
      state.originalImageUrl = null;
    }
    if (state.cleanImageUrl) {
      URL.revokeObjectURL(state.cleanImageUrl);
      state.cleanImageUrl = null;
    }
  }

  // ==========================================
  // 画面状態切り替え
  // ==========================================

  function setSectionState(stateName) {
    uploadSection.style.display = stateName === 'initial' ? 'block' : 'none';
    analysisSection.style.display = stateName === 'analyzed' ? 'block' : 'none';
    processingSection.style.display = (stateName === 'processing' || stateName === 'analyzing') ? 'flex' : 'none';
    resultSection.style.display = stateName === 'completed' ? 'block' : 'none';

    if (stateName === 'processing') {
      document.getElementById('processing-text').textContent = 'Exifメタデータを除去中...';
    } else if (stateName === 'analyzing') {
      document.getElementById('processing-text').textContent = '画像のExifメタデータを解析中...';
    }
  }

  // ==========================================
  // ユーティリティ
  // ==========================================

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
      reader.readAsArrayBuffer(file);
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function showAlert(type, message) {
    const validTypes = ['danger', 'warning', 'info'];
    const safeType = validTypes.includes(type) ? type : 'info';

    alertContainer.replaceChildren();

    const div = document.createElement('div');
    div.className = `alert alert-${safeType}`;

    const icon = document.createElement('span');
    icon.className = 'alert-icon';
    icon.textContent = (safeType === 'danger' || safeType === 'warning') ? '⚠️' : 'ℹ️';

    const content = document.createElement('div');
    content.className = 'alert-content';
    content.textContent = message;

    div.append(icon, content);
    alertContainer.append(div);
    alertContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function clearAlerts() {
    alertContainer.replaceChildren();
  }

  // 初期画面設定
  setSectionState('initial');
});
