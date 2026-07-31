<script setup lang="ts">
import {
  CirclePlay,
  FastForward,
  Maximize,
  RotateCcw,
  Settings,
  UserRound,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "@lucide/vue";
import { computed } from "vue";

export type StoryIconName = "play" | "replay" | "skip" | "settings" | "volume" | "mute" | "fullscreen" | "user";

defineOptions({ name: "StoryIcon" });
const props = defineProps<{ name: StoryIconName }>();

const icons: Readonly<Record<StoryIconName, LucideIcon>> = {
  play: CirclePlay,
  replay: RotateCcw,
  skip: FastForward,
  settings: Settings,
  volume: Volume2,
  mute: VolumeX,
  fullscreen: Maximize,
  user: UserRound,
};
const icon = computed(() => icons[props.name]);
</script>

<template>
  <span class="story-icon" aria-hidden="true">
    <component :is="icon" :stroke-width="2" />
  </span>
</template>

<style scoped>
.story-icon {
  align-items: center;
  display: inline-flex;
  flex: none;
  justify-content: center;
  line-height: 1;
}

.story-icon svg {
  display: block;
  height: 1em;
  width: 1em;
}
</style>
