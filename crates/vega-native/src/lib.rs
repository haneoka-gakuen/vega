use std::slice;
use vega_core::{CompletionTarget, Error, ExecutionCheckpoint, ExecutionSession};

fn status(result: Result<(), Error>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(error) => -(error as i32 + 1),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn vega_execution_abi_version() -> u32 {
    1
}

/// The host supplies a readable array and owns the returned session until destroy.
///
/// # Safety
/// Nonempty `indices` must reference `length` readable, aligned u32 elements.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_create(
    indices: *const u32,
    length: usize,
) -> *mut ExecutionSession {
    if length > 0 && indices.is_null() {
        return std::ptr::null_mut();
    }
    let commands = if length == 0 {
        Vec::new()
    } else {
        unsafe { slice::from_raw_parts(indices, length) }.to_vec()
    };
    match ExecutionSession::new(commands) {
        Ok(session) => Box::into_raw(Box::new(session)),
        Err(_) => std::ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
/// # Safety
/// `session` must come from create and must be destroyed exactly once, after
/// all calls using it have returned.
pub unsafe extern "C" fn vega_execution_destroy(session: *mut ExecutionSession) {
    if !session.is_null() {
        drop(unsafe { Box::from_raw(session) });
    }
}

/// Operation 0=start, 1=pause, 2=resume, 3=stop, 4=finish.
///
/// # Safety
/// `session` must be live and exclusively borrowed for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_control(
    session: *mut ExecutionSession,
    operation: u32,
) -> i32 {
    let Some(session) = (unsafe { session.as_mut() }) else {
        return -100;
    };
    match operation {
        0 => i32::from(session.start()),
        1 => {
            session.pause();
            0
        }
        2 => {
            session.resume();
            0
        }
        3 => {
            session.stop();
            0
        }
        4 => status(session.finish()),
        _ => -100,
    }
}

/// Writes cursor, generation, playing, paused and history count to five i64s.
///
/// # Safety
/// `session` must be live with no concurrent writer; `output` must contain
/// five writable, aligned i64 elements and must not alias the session.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_observe(
    session: *const ExecutionSession,
    output: *mut i64,
) -> i32 {
    let Some(session) = (unsafe { session.as_ref() }) else {
        return -100;
    };
    if output.is_null() {
        return -100;
    }
    let out = unsafe { slice::from_raw_parts_mut(output, 5) };
    out.copy_from_slice(&[
        session.cursor() as i64,
        session.generation() as i64,
        i64::from(session.playing()),
        i64::from(session.paused()),
        session.executions().len() as i64,
    ]);
    0
}

/// Returns the active blocking execution ID, or -1 when no command blocks.
///
/// # Safety
/// `session` must be live with no concurrent writer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_blocking_id(session: *const ExecutionSession) -> i64 {
    let Some(session) = (unsafe { session.as_ref() }) else {
        return -100;
    };
    session.blocking_execution_id().map_or(-1, |id| id as i64)
}

#[unsafe(no_mangle)]
/// # Safety
/// `session` must be live and exclusively borrowed for this call.
pub unsafe extern "C" fn vega_execution_begin(session: *mut ExecutionSession, at_us: u64) -> i64 {
    let Some(session) = (unsafe { session.as_mut() }) else {
        return -100;
    };
    match session.begin(at_us) {
        Ok(record) => record.id as i64,
        Err(error) => -(error as i64 + 1),
    }
}

#[unsafe(no_mangle)]
/// # Safety
/// `session` must be live and exclusively borrowed for this call.
pub unsafe extern "C" fn vega_execution_admit(
    session: *mut ExecutionSession,
    id: usize,
    wait: u32,
) -> i32 {
    let Some(session) = (unsafe { session.as_mut() }) else {
        return -100;
    };
    status(session.admit(id, wait != 0))
}

#[unsafe(no_mangle)]
/// # Safety
/// `session` must be live and exclusively borrowed for this call.
pub unsafe extern "C" fn vega_execution_complete(
    session: *mut ExecutionSession,
    id: usize,
    at_us: u64,
    next_index: i64,
) -> i32 {
    let Some(session) = (unsafe { session.as_mut() }) else {
        return -100;
    };
    let target = match next_index {
        -2 => CompletionTarget::End,
        -1 => CompletionTarget::Next,
        other => match u32::try_from(other) {
            Ok(index) => CompletionTarget::Index(index),
            Err(_) => return -100,
        },
    };
    status(session.complete_with_target(id, at_us, target))
}

/// # Safety
/// `session` must be live and exclusively borrowed for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_reposition(
    session: *mut ExecutionSession,
    position: usize,
) -> i32 {
    let Some(session) = (unsafe { session.as_mut() }) else {
        return -100;
    };
    status(session.reposition(position))
}

/// Copies one execution to six i64s. Optional values use -1.
///
/// # Safety
/// `session` must be live with no concurrent writer; `output` must contain
/// six writable, aligned i64 elements and must not alias the session.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_record(
    session: *const ExecutionSession,
    id: usize,
    output: *mut i64,
) -> i32 {
    let Some(session) = (unsafe { session.as_ref() }) else {
        return -100;
    };
    if output.is_null() {
        return -100;
    }
    let Some(record) = session.executions().get(id) else {
        return -100;
    };
    let out = unsafe { slice::from_raw_parts_mut(output, 6) };
    out.copy_from_slice(&[
        record.id as i64,
        i64::from(record.command_index),
        record.started_at_us as i64,
        record.completed_at_us.map_or(-1, |v| v as i64),
        if record.ends_sequence {
            -2
        } else {
            record.next_command_index.map_or(-1, i64::from)
        },
        record.wait_for_completion.map_or(-1, i64::from),
    ]);
    0
}

/// # Safety
/// `session` must be live with no concurrent writer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_checkpoint_size(session: *const ExecutionSession) -> isize {
    let Some(session) = (unsafe { session.as_ref() }) else {
        return -100;
    };
    match session
        .capture_checkpoint()
        .and_then(|value| value.to_words())
    {
        Ok(words) => words.len() as isize,
        Err(error) => -(error as isize + 1),
    }
}

/// # Safety
/// `session` is live without a concurrent writer; `output` references `length`
/// writable, aligned i64 elements and does not alias the session.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_checkpoint_write(
    session: *const ExecutionSession,
    output: *mut i64,
    length: usize,
) -> i32 {
    let Some(session) = (unsafe { session.as_ref() }) else {
        return -100;
    };
    if output.is_null() {
        return -100;
    }
    let words = match session
        .capture_checkpoint()
        .and_then(|value| value.to_words())
    {
        Ok(words) => words,
        Err(error) => return -(error as i32 + 1),
    };
    if words.len() != length {
        return -100;
    }
    unsafe { slice::from_raw_parts_mut(output, length) }.copy_from_slice(&words);
    0
}

/// # Safety
/// `session` is live and exclusively borrowed; `input` references `length`
/// readable, aligned i64 elements and does not alias the session.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_checkpoint_restore(
    session: *mut ExecutionSession,
    input: *const i64,
    length: usize,
) -> i32 {
    let Some(session) = (unsafe { session.as_mut() }) else {
        return -100;
    };
    if input.is_null() {
        return -100;
    }
    match ExecutionCheckpoint::from_words(unsafe { slice::from_raw_parts(input, length) }) {
        Ok(checkpoint) => status(session.restore_checkpoint(&checkpoint)),
        Err(error) => -(error as i32 + 1),
    }
}

/// # Safety
/// `session` must be live and exclusively borrowed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vega_execution_replay_mode(
    session: *mut ExecutionSession,
    enabled: u32,
) -> i32 {
    let Some(session) = (unsafe { session.as_mut() }) else {
        return -100;
    };
    status(session.set_replay_mode(enabled != 0))
}
