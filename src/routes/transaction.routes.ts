import { transactionController } from "@src/controllers";
import { Router, Request, Response } from "express";

export const transactionRouter: Router = Router();

transactionRouter.get("/fetchTransactions", (...args: [Request, Response]) =>
  transactionController.fetchTransactions(...args)
);
transactionRouter.get("/getJWTToken", (...args: [Request, Response]) =>
  transactionController.getJWTToken(...args)
);
transactionRouter.get("/getClockify", (...args: [Request, Response]) =>
  transactionController.getClockify(...args)
);
