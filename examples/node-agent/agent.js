// Independent function example: no Trialyard process or transport code.
export function createAgent() {
  let reservationKey = null;
  return {
    async runTurn({ input, history, tool }) {
      if (input.toLowerCase().includes("reserve")) {
        const stock = await tool("stock", {});
        if (stock.outcome !== "known_result") return "Inventory lookup did not return a known result.";
        reservationKey = `conversation-${history.length}`;
        return JSON.stringify(await tool("reserve", { key: reservationKey, quantity: 1 }));
      }
      return JSON.stringify({ reservationKey, reservations: await tool("reservations", {}) });
    }
  };
}
