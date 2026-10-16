use std::collections::{HashMap, HashSet};
mod checkpoint;
pub use checkpoint::ExecutionCheckpoint;

#[derive(Clone, Copy, Debug)]
pub struct Execution {
    pub id: usize,
    pub command_index: u32,
    pub started_at_us: u64,
    pub completed_at_us: Option<u64>,
    pub next_command_index: Option<u32>,
    pub wait_for_completion: Option<bool>,
    pub ends_sequence: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionTarget {
    Next,
    Index(u32),
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum Error {
    DuplicateCommandIndex,
    NotRunning,
    Paused,
    Waiting,
    EndOfCommands,
    UnknownExecution,
    AlreadyAdmitted,
    NotAdmitted,
    AlreadyCompleted,
    ClockRegression,
    BranchTarget,
    PendingCompletion,
    CheckpointFormat,
    CheckpointCommands,
}

/// Commands and host effects remain opaque. Only explicit host admissions and
/// acknowledgements advance the execution cursor.
pub struct ExecutionSession {
    commands: Vec<u32>,
    positions: HashMap<u32, usize>,
    executions: Vec<Execution>,
    execution_positions: HashMap<usize, usize>,
    next_execution_id: usize,
    outstanding: HashSet<usize>,
    awaiting_admission: Option<usize>,
    continuation_admission: Option<usize>,
    blocker: Option<usize>,
    cursor: usize,
    generation: u64,
    playing: bool,
    paused: bool,
    replay: bool,
}

impl ExecutionSession {
    pub fn new(commands: Vec<u32>) -> Result<Self, Error> {
        let positions: HashMap<_, _> = commands
            .iter()
            .copied()
            .enumerate()
            .map(|(position, index)| (index, position))
            .collect();
        if positions.len() != commands.len() {
            return Err(Error::DuplicateCommandIndex);
        }
        Ok(Self {
            commands,
            positions,
            executions: Vec::new(),
            execution_positions: HashMap::new(),
            next_execution_id: 0,
            outstanding: HashSet::new(),
            awaiting_admission: None,
            continuation_admission: None,
            blocker: None,
            cursor: 0,
            generation: 0,
            playing: false,
            paused: false,
            replay: false,
        })
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn playing(&self) -> bool {
        self.playing
    }
    pub fn paused(&self) -> bool {
        self.paused
    }
    pub fn executions(&self) -> &[Execution] {
        &self.executions
    }
    pub fn blocking_execution_id(&self) -> Option<usize> {
        self.blocker
    }

    pub fn start(&mut self) -> bool {
        if self.playing {
            return false;
        }
        self.playing = true;
        true
    }

    pub fn pause(&mut self) {
        self.paused = true;
    }
    pub fn resume(&mut self) {
        self.paused = false;
    }

    pub fn stop(&mut self) {
        self.generation += 1;
        self.playing = false;
        self.paused = false;
        self.awaiting_admission = None;
        self.continuation_admission = None;
        self.blocker = None;
        self.outstanding.clear();
        self.replay = false;
    }

    /// A seek starts a new execution era while preserving transport state.
    /// IDs remain session-unique so retired asynchronous acknowledgements
    /// cannot resolve a new execution with the same command index.
    pub fn reposition(&mut self, position: usize) -> Result<(), Error> {
        if position > self.commands.len() {
            return Err(Error::BranchTarget);
        }
        self.generation += 1;
        self.cursor = position;
        self.awaiting_admission = None;
        self.continuation_admission = None;
        self.blocker = None;
        self.outstanding.clear();
        self.executions.clear();
        self.execution_positions.clear();
        Ok(())
    }

    pub fn begin(&mut self, at_us: u64) -> Result<Execution, Error> {
        if !self.playing {
            return Err(Error::NotRunning);
        }
        if self.paused {
            return Err(Error::Paused);
        }
        if self.awaiting_admission.is_some() {
            return Err(Error::Waiting);
        }
        let command_index = *self.commands.get(self.cursor).ok_or(Error::EndOfCommands)?;
        if self
            .executions
            .last()
            .is_some_and(|previous| previous.started_at_us > at_us)
        {
            return Err(Error::ClockRegression);
        }
        if let Some(id) = self.blocker {
            let position = *self
                .execution_positions
                .get(&id)
                .ok_or(Error::UnknownExecution)?;
            let execution = self.executions[position];
            if execution.command_index != command_index
                || execution.completed_at_us.is_some()
                || execution.wait_for_completion != Some(true)
                || !self.outstanding.contains(&id)
            {
                return Err(Error::Waiting);
            }
            self.awaiting_admission = Some(id);
            self.continuation_admission = Some(id);
            return Ok(execution);
        }
        let execution = Execution {
            id: self.next_execution_id,
            command_index,
            started_at_us: at_us,
            completed_at_us: None,
            next_command_index: None,
            wait_for_completion: None,
            ends_sequence: false,
        };
        self.next_execution_id += 1;
        self.execution_positions
            .insert(execution.id, self.executions.len());
        self.executions.push(execution);
        self.awaiting_admission = Some(execution.id);
        Ok(execution)
    }

    pub fn admit(&mut self, id: usize, wait: bool) -> Result<(), Error> {
        let position = *self
            .execution_positions
            .get(&id)
            .ok_or(Error::UnknownExecution)?;
        let execution = &mut self.executions[position];
        let continuing = self.continuation_admission == Some(id);
        if execution.wait_for_completion.is_some() && !continuing {
            return Err(Error::AlreadyAdmitted);
        }
        if self.awaiting_admission != Some(id) {
            return Err(Error::NotRunning);
        }
        let wait = if continuing {
            execution.wait_for_completion.unwrap_or(wait)
        } else {
            wait
        };
        execution.wait_for_completion = Some(wait);
        self.awaiting_admission = None;
        self.continuation_admission = None;
        self.outstanding.insert(id);
        if wait {
            self.blocker = Some(id);
        } else {
            self.cursor += 1;
        }
        Ok(())
    }

    pub fn complete(&mut self, id: usize, at_us: u64, next: Option<u32>) -> Result<(), Error> {
        self.complete_with_target(
            id,
            at_us,
            next.map_or(CompletionTarget::Next, CompletionTarget::Index),
        )
    }

    pub fn complete_with_target(
        &mut self,
        id: usize,
        at_us: u64,
        target: CompletionTarget,
    ) -> Result<(), Error> {
        let position = *self
            .execution_positions
            .get(&id)
            .ok_or(Error::UnknownExecution)?;
        let execution = &self.executions[position];
        if execution.completed_at_us.is_some() {
            return Err(Error::AlreadyCompleted);
        }
        let wait = execution.wait_for_completion.ok_or(Error::NotAdmitted)?;
        if !self.outstanding.contains(&id) {
            return Err(Error::NotRunning);
        }
        if at_us < execution.started_at_us {
            return Err(Error::ClockRegression);
        }
        let next_position = if wait {
            match target {
                CompletionTarget::Index(index) => {
                    Some(*self.positions.get(&index).ok_or(Error::BranchTarget)?)
                }
                CompletionTarget::Next => None,
                CompletionTarget::End => Some(self.commands.len()),
            }
        } else {
            None
        };
        let execution = &mut self.executions[position];
        execution.completed_at_us = Some(at_us);
        execution.next_command_index = match target {
            CompletionTarget::Index(index) => Some(index),
            _ => None,
        };
        execution.ends_sequence = target == CompletionTarget::End;
        self.outstanding.remove(&id);
        if self.blocker == Some(id) {
            self.blocker = None;
            self.cursor = next_position.unwrap_or(self.cursor + 1);
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), Error> {
        if self.awaiting_admission.is_some() || !self.outstanding.is_empty() {
            return Err(Error::PendingCompletion);
        }
        self.playing = false;
        Ok(())
    }

    /// Replay uses the same explicit blocking/detached admissions as playback.
    pub fn set_replay_mode(&mut self, enabled: bool) -> Result<(), Error> {
        if self.awaiting_admission.is_some() {
            return Err(Error::PendingCompletion);
        }
        self.replay = enabled;
        Ok(())
    }
}
