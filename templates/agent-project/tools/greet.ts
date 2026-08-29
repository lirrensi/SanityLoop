// A tool. Default-export the definition — the loader registers it on the agent.
export default {
	name: "greet",
	description: "Greet someone by name.",
	inputSchema: {
		type: "object",
		properties: { name: { type: "string" } },
		required: ["name"],
	},
	async execute(params: { name: string }) {
		return { answer: `Hello, ${params.name}!` };
	},
};