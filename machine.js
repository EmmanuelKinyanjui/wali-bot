import { createMachine } from "xstate";

export const machine = createMachine({
    context: {
        name: null
    },
    id: "Welcome Message",
    initial: "Start",
    states: {
        "Start": {
            on: {
                "Provide Name": {
                    target: "Welcome Message",
                },
            },
        },
        "Welcome Message": {
            type: "final",
        },
    },
}).withConfig({});
