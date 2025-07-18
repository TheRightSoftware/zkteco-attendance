import { TransactionService } from "@src/services/transaction.service";
import { Request, Response } from "express";

export class TransactionController {
  /**
   * @param __service
   */

  public constructor(public __service: TransactionService) {}
  /**
   *
   * @param req
   * @param res
   * @param next
   */

  public fetchTransactions = async (req: Request, res: Response) => {
    try {
      let message = "Transactions fetched successfully.";
      const response: any = await this.__service.fetchTransactions();

      res.status(200).json({
        statusCode: 200,
        message,
        response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public getJWTToken = async (req: Request, res: Response) => {
    try {
      const { query } = req;
      const response: any = await this.__service.getJWTToken(query);
      res.status(200).json({
        statusCode: 200,
        message: "JWT Token fetched successfully.",
        response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public getClockify = async (req: Request, res: Response) => {
    try {
      const { query } = req;
      const response: any = await this.__service.getClockify();
      res.status(200).json({
        statusCode: 200,
        message: "Data fetched successfully.",
        response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };
}
