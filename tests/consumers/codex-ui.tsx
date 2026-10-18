import {codexStudioSettings} from '@openhilo/ai-codex/studio';

const Editor = codexStudioSettings.Editor;
export const example = <Editor config={{}} savedConfig={{}} onChange={patch => void patch}
                               onValidityChange={valid => void valid}/>;
export const patch = codexStudioSettings.createPatch({});
