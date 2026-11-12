//! In-process page layout detection (replaces Moonlight's `ml.themoonlight.io/detect`).
//!
//! DocLayout-YOLO (DocStructBench, YOLOv10: NMS-free, output `[1, 300, 6]` = x1, y1, x2, y2,
//! score, class) run with ONNX Runtime. Classes match Moonlight's BOX_CLASS enum 0..9.

use image::{imageops::FilterType, RgbImage};
use ort::{environment::Environment, session::Session, value::Tensor};
use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};

const SIZE: u32 = 1024;
const PAD: u8 = 114;
const MIN_SCORE: f32 = 0.2; // DocLayout-YOLO's documented default; Moonlight's server value is not observable

#[derive(Serialize)]
pub struct DetectedBox {
    pub box_cls: f32,
    /// centre x, centre y, width, height — normalised to the page image
    pub box_xywhn: [f32; 4],
}

pub struct Detector {
    model: PathBuf,
    session: Mutex<Option<(Environment, Session)>>,
}

impl Detector {
    pub fn new(model: PathBuf) -> Self {
        Self { model, session: Mutex::new(None) }
    }

    /// Blocking: call from `spawn_blocking`. The model is loaded on first use.
    pub fn detect(&self, image_bytes: &[u8]) -> Result<Vec<DetectedBox>, String> {
        let page = image::load_from_memory(image_bytes).map_err(|e| format!("image: {e}"))?.to_rgb8();
        let (w, h) = page.dimensions();
        if w == 0 || h == 0 {
            return Ok(vec![]);
        }
        // Letterbox: scale to fit SIZE x SIZE, centre on a grey canvas (what the model was trained with).
        let scale = (SIZE as f32 / w as f32).min(SIZE as f32 / h as f32);
        let (nw, nh) = (((w as f32 * scale).round() as u32).clamp(1, SIZE), ((h as f32 * scale).round() as u32).clamp(1, SIZE));
        let (px, py) = ((SIZE - nw) / 2, (SIZE - nh) / 2);
        let resized: RgbImage = image::imageops::resize(&page, nw, nh, FilterType::Triangle);
        let side = SIZE as usize;
        let mut input = vec![PAD as f32 / 255.0; 3 * side * side]; // NCHW
        for (x, y, pixel) in resized.enumerate_pixels() {
            let at = (y + py) as usize * side + (x + px) as usize;
            for c in 0..3 {
                input[c * side * side + at] = pixel[c] as f32 / 255.0;
            }
        }

        let mut guard = self.session.lock().map_err(|_| "detector poisoned")?;
        if guard.is_none() {
            let load = || -> ort::Result<(Environment, Session)> {
                let env = ort::environment::init().with_name("sunlight").build()?;
                let mut builder = Session::builder(&env)?;
                // macOS: run on the GPU / Neural Engine through Core ML (falls back to CPU for
                // unsupported nodes). The compiled model is cached so later launches start fast.
                #[cfg(target_os = "macos")]
                {
                    use ort::ep::coreml::{ComputeUnits, CoreML, ModelFormat};
                    let cache = dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("Sunlight").join("coreml");
                    let _ = std::fs::create_dir_all(&cache);
                    let coreml = CoreML::default().with_model_format(ModelFormat::MLProgram).with_compute_units(ComputeUnits::All).with_model_cache_dir(cache.display());
                    builder = builder.with_execution_providers([coreml.build()]).map_err(ort::Error::<()>::from)?;
                }
                let session = builder.commit_from_file(&self.model)?;
                Ok((env, session))
            };
            *guard = Some(load().map_err(|e| format!("model: {e}"))?);
        }
        let session = &mut guard.as_mut().unwrap().1;
        let tensor = Tensor::from_array(([1, 3, side, side], input)).map_err(|e| e.to_string())?;
        let outputs = session.run(ort::inputs!["images" => tensor]).map_err(|e| e.to_string())?;
        let (_, rows) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;

        Ok(rows
            .chunks_exact(6)
            .filter(|r| r[4] >= MIN_SCORE)
            .map(|r| DetectedBox {
                box_cls: r[5],
                box_xywhn: [
                    ((r[0] + r[2]) / 2.0 - px as f32) / nw as f32,
                    ((r[1] + r[3]) / 2.0 - py as f32) / nh as f32,
                    (r[2] - r[0]) / nw as f32,
                    (r[3] - r[1]) / nh as f32,
                ],
            })
            .collect())
    }
}
