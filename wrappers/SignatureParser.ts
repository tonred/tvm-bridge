import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export class SignatureParser implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new SignatureParser(address);
    }

    static createFromConfig(args: { id: number }, code: Cell, workchain = 0) {
        const init = { code, data: beginCell().storeUint(args.id, 32).endCell() };
        return new SignatureParser(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getSignaturesHash(
        provider: ContractProvider,
        args: { signatures: Cell; rootHash: Buffer; fileHash: Buffer },
    ) {
        const result = await provider.get('get_signatures_hash', [
            {
                type: 'cell',
                cell: args.signatures,
            },
            {
                type: 'int',
                value: BigInt(`0x${args.rootHash.toString('hex')}`),
            },
            {
                type: 'int',
                value: BigInt(`0x${args.fileHash.toString('hex')}`),
            },
        ]);
        return {
            signatures: result.stack.readCell(),
            hash: result.stack.readBuffer(),
        };
    }
}
