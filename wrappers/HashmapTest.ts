import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export class HashmapTest implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromConfig(code: Cell, workchain = 0) {
        const data = beginCell().endCell();
        const init = { code, data };
        const address = contractAddress(workchain, init);
        return new HashmapTest(address, init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendTestOne(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: string | bigint;
            dict: Cell;
            key: Cell;
            expected: Cell;
        },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(0x1, 32)
                .storeRef(opts.dict)
                .storeRef(opts.key)
                .storeRef(opts.expected)
                .endCell(),
        });
    }

    async sendTestFull(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: string | bigint;
            keyBits: number;
            dict: Cell;
        },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(0x2, 32)
                .storeUint(opts.keyBits, 32)
                .storeUint(0, opts.keyBits)
                .storeRef(opts.dict)
                .endCell(),
        });
    }
}
