#ifndef VEGA_RUNTIME_H
#define VEGA_RUNTIME_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct VegaExecutionSession VegaExecutionSession;
uint32_t vega_execution_abi_version(void);
VegaExecutionSession *vega_execution_create(const uint32_t *indices, size_t length);
void vega_execution_destroy(VegaExecutionSession *session);
/* 0=start (returns 1 when admitted), 1=pause, 2=resume, 3=stop, 4=finish. */
int32_t vega_execution_control(VegaExecutionSession *session, uint32_t operation);
/* Five fields: cursor, generation, playing, paused, execution count. */
int32_t vega_execution_observe(const VegaExecutionSession *session, int64_t output[5]);
/* Active blocking execution ID, or -1 when no command blocks. */
int64_t vega_execution_blocking_id(const VegaExecutionSession *session);
int64_t vega_execution_begin(VegaExecutionSession *session, uint64_t at_us);
int32_t vega_execution_admit(VegaExecutionSession *session, size_t id, uint32_t wait);
int32_t vega_execution_complete(VegaExecutionSession *session, size_t id,
    uint64_t at_us, int64_t next_index);
/* next_index: -1=next command, -2=end, otherwise an actual command index. */
int32_t vega_execution_reposition(VegaExecutionSession *session, size_t position);
/* Six fields: id, command index, start us, completion us, branch index, wait.
   Optional fields use -1; branch index -2 marks explicit end. The record
   argument is a history position; execution IDs remain unique across seeks.
   Read only while the owning session is alive. */
int32_t vega_execution_record(const VegaExecutionSession *session, size_t id,
    int64_t output[6]);
intptr_t vega_execution_checkpoint_size(const VegaExecutionSession *session);
int32_t vega_execution_checkpoint_write(const VegaExecutionSession *session,
    int64_t *output, size_t length);
int32_t vega_execution_checkpoint_restore(VegaExecutionSession *session,
    const int64_t *input, size_t length);
int32_t vega_execution_replay_mode(VegaExecutionSession *session, uint32_t enabled);

#ifdef __cplusplus
}
#endif
#endif
