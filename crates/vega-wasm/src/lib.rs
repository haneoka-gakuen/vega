use vega_core::{CompletionTarget, Execution, ExecutionCheckpoint, ExecutionSession};
use wasm_bindgen::prelude::*;

fn failure(error: vega_core::Error) -> JsValue {
    JsValue::from_str(&format!("vega_execution:{error:?}"))
}

fn timestamp(value: f64) -> Result<u64, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > 9_007_199_254_740_991.0
    {
        return Err(JsValue::from_str("vega_execution:invalid_timestamp"));
    }
    Ok(value as u64)
}

fn fields(record: Execution) -> Box<[f64]> {
    Box::new([
        record.id as f64,
        record.command_index as f64,
        record.started_at_us as f64,
        record.completed_at_us.map_or(-1.0, |v| v as f64),
        record.next_command_index.map_or(-1.0, |v| v as f64),
        record
            .wait_for_completion
            .map_or(-1.0, |v| f64::from(u8::from(v))),
        f64::from(u8::from(record.ends_sequence)),
    ])
}

/// Thin WebAssembly adapter; source commands, rendering, clocks and media stay with hosts.
#[wasm_bindgen]
pub struct VegaExecution {
    session: ExecutionSession,
}

#[wasm_bindgen]
impl VegaExecution {
    #[wasm_bindgen(constructor)]
    pub fn new(indices: Box<[u32]>) -> Result<Self, JsValue> {
        Ok(Self {
            session: ExecutionSession::new(indices.into_vec()).map_err(failure)?,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn cursor(&self) -> usize {
        self.session.cursor()
    }
    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> f64 {
        self.session.generation() as f64
    }
    #[wasm_bindgen(getter)]
    pub fn playing(&self) -> bool {
        self.session.playing()
    }
    #[wasm_bindgen(getter)]
    pub fn paused(&self) -> bool {
        self.session.paused()
    }
    #[wasm_bindgen(getter, js_name = historyCount)]
    pub fn history_count(&self) -> usize {
        self.session.executions().len()
    }

    #[wasm_bindgen(getter, js_name = blockingExecutionId)]
    pub fn blocking_execution_id(&self) -> Option<usize> {
        self.session.blocking_execution_id()
    }

    pub fn start(&mut self) -> bool {
        self.session.start()
    }
    pub fn pause(&mut self) {
        self.session.pause();
    }
    pub fn resume(&mut self) {
        self.session.resume();
    }
    pub fn stop(&mut self) {
        self.session.stop();
    }
    pub fn reposition(&mut self, position: usize) -> Result<(), JsValue> {
        self.session.reposition(position).map_err(failure)
    }
    pub fn finish(&mut self) -> Result<(), JsValue> {
        self.session.finish().map_err(failure)
    }

    pub fn begin(&mut self, at_us: f64) -> Result<Box<[f64]>, JsValue> {
        Ok(fields(
            self.session.begin(timestamp(at_us)?).map_err(failure)?,
        ))
    }
    pub fn admit(&mut self, id: usize, wait: bool) -> Result<(), JsValue> {
        self.session.admit(id, wait).map_err(failure)
    }
    pub fn complete(
        &mut self,
        id: usize,
        at_us: f64,
        next_index: Option<u32>,
        ends_sequence: bool,
    ) -> Result<(), JsValue> {
        let target = if ends_sequence {
            CompletionTarget::End
        } else {
            next_index.map_or(CompletionTarget::Next, CompletionTarget::Index)
        };
        self.session
            .complete_with_target(id, timestamp(at_us)?, target)
            .map_err(failure)
    }
    pub fn record(&self, id: usize) -> Result<Box<[f64]>, JsValue> {
        let record = self
            .session
            .executions()
            .get(id)
            .ok_or_else(|| JsValue::from_str("vega_execution:record_missing"))?;
        Ok(fields(*record))
    }

    #[wasm_bindgen(js_name = captureCheckpoint)]
    pub fn capture_checkpoint(&self) -> Result<Box<[f64]>, JsValue> {
        let words = self
            .session
            .capture_checkpoint()
            .and_then(|value| value.to_words())
            .map_err(failure)?;
        if words
            .iter()
            .any(|value| value.unsigned_abs() > 9_007_199_254_740_991)
        {
            return Err(JsValue::from_str("vega_execution:checkpoint_number_range"));
        }
        Ok(words.into_iter().map(|value| value as f64).collect())
    }

    #[wasm_bindgen(js_name = restoreCheckpoint)]
    pub fn restore_checkpoint(&mut self, words: Box<[f64]>) -> Result<(), JsValue> {
        if words.iter().any(|value| {
            !value.is_finite() || value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0
        }) {
            return Err(JsValue::from_str("vega_execution:checkpoint_number_range"));
        }
        let words: Vec<i64> = words.into_iter().map(|value| value as i64).collect();
        let checkpoint = ExecutionCheckpoint::from_words(&words).map_err(failure)?;
        self.session
            .restore_checkpoint(&checkpoint)
            .map_err(failure)
    }

    #[wasm_bindgen(js_name = setReplayMode)]
    pub fn set_replay_mode(&mut self, enabled: bool) -> Result<(), JsValue> {
        self.session.set_replay_mode(enabled).map_err(failure)
    }
}
