import type {JsonObject} from '@openhilo/ai-contracts';
import {configureAiRouting, type ConfiguredAiTarget} from '@openhilo/ai-contracts/routing';
import {AI_TYPES, type AiSelection} from '@openhilo/itt-contracts/ai-selection';
import {startRun, type RunComposition} from '@openhilo/runtime/run-service';
const choose: AiSelection = {type:'coding',level:'pro'};
const make = (factory:(config:JsonObject)=>ConfiguredAiTarget) => configureAiRouting({default:{defaultLevel:'medium',levels:{medium:{}}}},factory);
const use = (composition:RunComposition) => composition.aiRoutingIdentity;
void [choose,make,use,startRun,AI_TYPES];
