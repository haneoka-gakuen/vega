use super::{Error, Execution, ExecutionSession};
use std::collections::HashSet;

/// Execution history only. Scene, resource, media and decision state belongs
/// to the host checkpoint that carries this value.
#[derive(Clone, Debug)]
pub struct ExecutionCheckpoint {
    commands: Vec<u32>,
    cursor: usize,
    executions: Vec<Execution>,
    next_execution_id: usize,
    outstanding: HashSet<usize>,
    blocker: Option<usize>,
}

impl ExecutionCheckpoint {
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// Version, command count, cursor, history count, next ID, command indices,
    /// then six signed fields per record. Version two appends active count,
    /// blocking ID (or -1), and sorted active IDs; record ABI stays unchanged.
    pub fn to_words(&self) -> Result<Vec<i64>, Error> {
        let number = |value: usize| i64::try_from(value).map_err(|_| Error::CheckpointFormat);
        let mut words = vec![
            2,
            number(self.commands.len())?,
            number(self.cursor)?,
            number(self.executions.len())?,
            number(self.next_execution_id)?,
        ];
        words.extend(self.commands.iter().map(|value| i64::from(*value)));
        for record in &self.executions {
            words.extend([
                number(record.id)?,
                i64::from(record.command_index),
                i64::try_from(record.started_at_us).map_err(|_| Error::CheckpointFormat)?,
                record.completed_at_us.map_or(Ok(-1), |value| {
                    i64::try_from(value).map_err(|_| Error::CheckpointFormat)
                })?,
                if record.ends_sequence {
                    -2
                } else {
                    record.next_command_index.map_or(-1, i64::from)
                },
                record.wait_for_completion.map_or(-1, i64::from),
            ]);
        }
        words.push(number(self.outstanding.len())?);
        words.push(self.blocker.map_or(Ok(-1), number)?);
        let mut active: Vec<_> = self.outstanding.iter().copied().collect();
        active.sort_unstable();
        for id in active {
            words.push(number(id)?);
        }
        Ok(words)
    }

    pub fn from_words(words: &[i64]) -> Result<Self, Error> {
        let invalid = || Error::CheckpointFormat;
        let size = |value: i64| usize::try_from(value).map_err(|_| invalid());
        if words.len() < 5 || !matches!(words[0], 1 | 2) {
            return Err(invalid());
        }
        let command_count = size(words[1])?;
        let cursor = size(words[2])?;
        let history_count = size(words[3])?;
        let next_execution_id = size(words[4])?;
        let length = history_count
            .checked_mul(6)
            .and_then(|count| count.checked_add(command_count))
            .and_then(|count| count.checked_add(5))
            .ok_or_else(invalid)?;
        if cursor > command_count
            || (words[0] == 1 && words.len() != length)
            || (words[0] == 2 && words.len().checked_sub(length).is_none_or(|tail| tail < 2))
        {
            return Err(invalid());
        }
        let commands = words[5..5 + command_count]
            .iter()
            .map(|value| u32::try_from(*value).map_err(|_| invalid()))
            .collect::<Result<Vec<_>, _>>()?;
        let allowed: HashSet<_> = commands.iter().copied().collect();
        if allowed.len() != command_count {
            return Err(invalid());
        }
        let mut executions = Vec::with_capacity(history_count);
        let mut ids = HashSet::with_capacity(history_count);
        let mut previous_start = 0;
        for row in words[5 + command_count..length].as_chunks::<6>().0 {
            let id = size(row[0])?;
            let command_index = u32::try_from(row[1]).map_err(|_| invalid())?;
            let started_at_us = u64::try_from(row[2]).map_err(|_| invalid())?;
            let completed_at_us = if row[3] == -1 {
                None
            } else {
                Some(u64::try_from(row[3]).map_err(|_| invalid())?)
            };
            let next_command_index = if row[4] < 0 {
                if row[4] != -1 && row[4] != -2 {
                    return Err(invalid());
                }
                None
            } else {
                let index = u32::try_from(row[4]).map_err(|_| invalid())?;
                if !allowed.contains(&index) {
                    return Err(invalid());
                }
                Some(index)
            };
            let wait_for_completion = match row[5] {
                -1 => None,
                0 => Some(false),
                1 => Some(true),
                _ => return Err(invalid()),
            };
            if !ids.insert(id)
                || id >= next_execution_id
                || !allowed.contains(&command_index)
                || started_at_us < previous_start
                || completed_at_us.is_some_and(|value| value < started_at_us)
                || (completed_at_us.is_some() && wait_for_completion.is_none())
                || (completed_at_us.is_none() && row[4] != -1)
            {
                return Err(invalid());
            }
            previous_start = started_at_us;
            executions.push(Execution {
                id,
                command_index,
                started_at_us,
                completed_at_us,
                next_command_index,
                wait_for_completion,
                ends_sequence: row[4] == -2,
            });
        }
        // Version one carried no active ownership. Incomplete rows may have
        // been cancelled before capture, so they remain historical records.
        let mut outstanding = HashSet::new();
        let mut blocker = None;
        if words[0] == 2 {
            let count = size(words[length])?;
            if words.len()
                != length
                    .checked_add(count)
                    .and_then(|n| n.checked_add(2))
                    .ok_or_else(invalid)?
            {
                return Err(invalid());
            }
            blocker = if words[length + 1] == -1 {
                None
            } else {
                Some(size(words[length + 1])?)
            };
            for &word in &words[length + 2..] {
                let id = size(word)?;
                let record = executions
                    .iter()
                    .find(|record| record.id == id)
                    .ok_or_else(invalid)?;
                if !outstanding.insert(id)
                    || record.completed_at_us.is_some()
                    || record.wait_for_completion.is_none()
                {
                    return Err(invalid());
                }
            }
            let blocking: Vec<_> = executions
                .iter()
                .filter(|record| {
                    outstanding.contains(&record.id) && record.wait_for_completion == Some(true)
                })
                .collect();
            if blocking.len() > 1
                || blocking.first().map(|record| record.id) != blocker
                || blocking
                    .first()
                    .is_some_and(|record| commands.get(cursor) != Some(&record.command_index))
            {
                return Err(invalid());
            }
        }
        Ok(Self {
            commands,
            cursor,
            executions,
            next_execution_id,
            outstanding,
            blocker,
        })
    }
}

impl ExecutionSession {
    pub fn capture_checkpoint(&self) -> Result<ExecutionCheckpoint, Error> {
        if self.awaiting_admission.is_some() {
            return Err(Error::PendingCompletion);
        }
        Ok(ExecutionCheckpoint {
            commands: self.commands.clone(),
            cursor: self.cursor,
            executions: self.executions.clone(),
            next_execution_id: self.next_execution_id,
            outstanding: self.outstanding.clone(),
            blocker: self.blocker,
        })
    }

    /// The host commits this only after its restored resources were presented.
    /// Transport stays stopped; the host starts a fresh playback loop explicitly.
    pub fn restore_checkpoint(&mut self, checkpoint: &ExecutionCheckpoint) -> Result<(), Error> {
        if checkpoint.commands != self.commands {
            return Err(Error::CheckpointCommands);
        }
        self.generation += 1;
        self.cursor = checkpoint.cursor;
        self.executions = checkpoint.executions.clone();
        self.execution_positions = self
            .executions
            .iter()
            .enumerate()
            .map(|(position, record)| (record.id, position))
            .collect();
        self.next_execution_id = self.next_execution_id.max(checkpoint.next_execution_id);
        self.awaiting_admission = None;
        self.continuation_admission = None;
        self.blocker = checkpoint.blocker;
        self.outstanding = checkpoint.outstanding.clone();
        self.playing = false;
        self.paused = false;
        self.replay = false;
        Ok(())
    }
}
