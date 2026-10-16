#include <stdint.h>

extern uint32_t vega_execution_abi_version(void);

uint32_t vega_runtime_ffi_link_anchor(void) {
  return vega_execution_abi_version();
}
