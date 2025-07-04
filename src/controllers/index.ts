import { transactionService } from "@src/services";
import { TransactionController } from "./transaction.controller";


export const transactionController: TransactionController = new TransactionController(transactionService);
