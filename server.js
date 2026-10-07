const express = require("express");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const PORT = 3000;
const { spawn } = require("child_process");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());

const streamSessions = new Map();

// ==========================================
// BIẾN LƯU PUBLIC CDN URL TỪ CLOUDFLARE
// ==========================================
let publicCdnUrl = null;

const uploadDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const upload = multer({ dest: uploadDir });

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(outputDir));

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>P2P Media Stream CDN</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>

<body class="bg-slate-900 text-slate-100 min-h-screen flex items-center justify-center p-6">

  <div class="max-w-md w-full bg-slate-800 rounded-xl shadow-2xl p-6 border border-slate-700">

    <h1 class="text-2xl font-bold mb-4 text-emerald-400 text-center">
      P2P Video Transcoder
    </h1>

    <div class="space-y-4">

      <input
        type="file"
        id="videoInput"
        accept="video/mp4,video/*"
        class="w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-emerald-600 file:text-white hover:file:bg-emerald-500 cursor-pointer"
      >

      <button
        id="convertBtn"
        class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
      >
        Transcode Stream UUID
      </button>

      <div
        id="logBox"
        class="bg-slate-950 p-3 rounded-lg border border-slate-800 font-mono text-xs text-slate-300 h-32 overflow-y-auto space-y-1"
      >
        <div>&gt; READY...</div>
      </div>

    </div>
  </div>

  <script src="/app.js"></script>

</body>
</html>`);
});

app.post("/transcode", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file selected!" });
  }

  const cpuThreads = os.cpus().length;
  const ffmpegThreads = Math.max(1, Math.floor(cpuThreads * 0.8));

  const inputPath = req.file.path;
  const sessionFolder = Date.now().toString();
  const currentOutputDir = path.join(outputDir, sessionFolder);

  if (!fs.existsSync(currentOutputDir))
    fs.mkdirSync(currentOutputDir, { recursive: true });

  const outputPath = path.join(currentOutputDir, "stream.m3u8");

  console.log(
    `[${new Date().toLocaleTimeString()}] Đang transcode: ${req.file.originalname}`
  );

  ffmpeg(inputPath)
    .inputOptions(["-err_detect", "ignore_err"])
    .outputOptions([
      "-map 0:v:0",
      "-map 0:a:0?",

      "-c:v libx264",
      "-preset ultrafast",
      "-tune zerolatency",
      `-threads ${ffmpegThreads}`,
      "-fps_mode vfr",

      "-g 60",
      "-keyint_min 60",
      "-sc_threshold 0",

      "-c:a aac",
      "-b:a 128k",
      "-ar 48000",
      "-ac 2",

      "-hls_time 4",
      "-hls_list_size 0",
      "-hls_flags independent_segments",

      "-f hls",
    ])
    .output(outputPath)
    .on("start", (commandLine) => {
      console.log("FFmpeg:");
      console.log(commandLine);
    })
    .on("stderr", (line) => {
      console.log("[FFmpeg]", line);
    })
    .on("progress", (progress) => {
      if (progress.percent) {
        console.log(`Progress: ${progress.percent.toFixed(1)}%`);
      }
    })
    .on("end", () => {
      console.log("-> Transcode HLS xong!");

      fs.unlink(inputPath, () => {});

      const streamId = crypto.randomUUID();
      streamSessions.set(streamId, sessionFolder);

      // ==========================================
      // ƯU TIÊN LẤY PUBLIC CDN URL TỪ CLOUDFLARE
      // ==========================================
      let baseUrl = publicCdnUrl;

      if (!baseUrl) {
        const protocol = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.get("host");
        baseUrl = `${protocol}://${host}`;
      }

      const watchUrl = `${baseUrl}/stream/${streamId}`;
      console.log("watchUrl:", watchUrl);

      res.json({
        status: "ok",
        streamId,
        watchUrl,
      });
    })
    .on("error", (err) => {
      console.error("ERROR FFmpeg:", err.message);

      fs.unlink(inputPath, () => {});

      if (!res.headersSent) {
        res.status(500).json({
          error: err.message,
        });
      }
    })
    .run();
});

app.get("/stream/:streamId", (req, res) => {
  const { streamId } = req.params;
  const sessionFolder = streamSessions.get(streamId);

  if (!sessionFolder) {
    return res.status(404).send(`
      <h2 style="font-family:sans-serif; text-align:center; margin-top:50px; color:#ef4444;">
        404 - The stream link does not exist or has expired!
      </h2>
    `);
  }

  // Ưu tiên dùng CDN Link để load manifest segment
  let baseUrl = publicCdnUrl;
  if (!baseUrl) {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.get("host");
    baseUrl = `${protocol}://${host}`;
  }

  const manifestUrl = `${baseUrl}/output/${sessionFolder}/stream.m3u8`;

  res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <title>Stream - ${streamId}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
      <script src="https://cdn.jsdelivr.net/npm/p2p-media-loader-core@latest/build/p2p-media-loader-core.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/p2p-media-loader-hlsjs@latest/build/p2p-media-loader-hlsjs.min.js"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 min-h-screen flex flex-col items-center justify-center p-6">
      <div class="max-w-4xl w-full bg-slate-800 rounded-xl shadow-2xl p-6 border border-slate-700">
        <h1 class="text-xl font-bold mb-3 text-emerald-400 font-mono break-all">
          Stream ID: ${streamId}
        </h1>
        
        <div class="relative aspect-video bg-black rounded-lg overflow-hidden border border-slate-700 mb-4">
          <video id="videoPlayer" controls autoplay class="w-full h-full"></video>
        </div>

        <div class="grid grid-cols-2 gap-4 text-center font-mono">
          <div class="bg-slate-900 p-3 rounded-lg border border-slate-700">
            <span class="text-xs text-slate-400 block mb-1">HTTP Downloaded</span>
            <span id="httpDownloaded" class="text-lg font-bold text-sky-400">0.00 <span class="text-xs text-slate-500 font-normal">MB</span></span>
          </div>
          <div class="bg-slate-900 p-3 rounded-lg border border-slate-700">
            <span class="text-xs text-slate-400 block mb-1">P2P Downloaded</span>
            <span id="p2pDownloaded" class="text-lg font-bold text-emerald-400">0.00 <span class="text-xs text-slate-500 font-normal">MB</span></span>
          </div>
        </div>

      </div>

      <script>
        const videoPlayer = document.getElementById('videoPlayer');
        const manifestUrl = "${manifestUrl}";

        let httpBytes = 0;
        let p2pBytes = 0;

        const isP2PSupported = window.p2pMediaLoaderHlsjs?.HlsJsEngine?.isSupported();

        if (isP2PSupported && Hls.isSupported()) {
          const p2pEngine = new p2pMediaLoaderHlsjs.HlsJsEngine({
            segment: {
              trackerAnnounce: [
                'wss://tracker.openwebrtc.se',
                'wss://tracker.files.fm:7070/announce',
                'wss://tracker.novage.com.ua'
              ]
            }
          });

          p2pEngine.addEventListener('segment_loaded', (e) => {
            if (e.detail.downloadByHttp) {
              httpBytes += e.detail.size;
            } else {
              p2pBytes += e.detail.size;
            }
            document.getElementById('httpDownloaded').innerHTML = (httpBytes / (1024 * 1024)).toFixed(2) + ' <span class="text-xs text-slate-500 font-normal">MB</span>';
            document.getElementById('p2pDownloaded').innerHTML = (p2pBytes / (1024 * 1024)).toFixed(2) + ' <span class="text-xs text-slate-500 font-normal">MB</span>';
          });

          const hls = new Hls({
            liveSyncDurationCount: 3,
            loader: p2pEngine.createLoaderClass()
          });

          p2pEngine.bindHlsjs(hls);
          hls.loadSource(manifestUrl);
          hls.attachMedia(videoPlayer);
        } else if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(manifestUrl);
          hls.attachMedia(videoPlayer);
        } else {
          videoPlayer.src = manifestUrl;
        }
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Local Server running: http://localhost:${PORT}`);

  const tunnel = spawn("npx", ["cloudflared", "tunnel", "--url", `http://localhost:${PORT}`], {
    shell: true
  });

  tunnel.stderr.on("data", (data) => {
    const output = data.toString();
    
    // Bắt link CDN public và gán vào biến global publicCdnUrl
    const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      publicCdnUrl = match[0];
      console.log(`\n🌐 Public CDN Tunnel URL: ${publicCdnUrl}\n`);
    }
  });

  tunnel.on("error", (err) => {
    console.error("Lỗi khi mở Cloudflare Tunnel:", err.message);
  });
});